//! A file its owner alone may read, on Windows, where a file's mode is its access list: one of its own, which allows
//! the user who runs ff everything and nobody else anything, inherited from no folder. And who else may read one, for
//! the credentials' warning, as OpenSSH for Windows reads a key's: the system and the administrators, who may read
//! every file, aren't named.

use std::ffi::{OsString, c_void};
use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, GENERIC_ALL, GENERIC_READ, HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GetNamedSecurityInfoW, NO_MULTIPLE_TRUSTEE, SE_FILE_OBJECT, SET_ACCESS,
    SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation, DACL_SECURITY_INFORMATION, EqualSid, GetAce,
    GetAclInformation, GetTokenInformation, INHERIT_ONLY_ACE, IsWellKnownSid, LookupAccountSidW, NO_INHERITANCE,
    PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER, TokenUser,
    WinBuiltinAdministratorsSid, WinLocalSystemSid,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_ALL_ACCESS, FILE_READ_DATA};
use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Gives the file an access list of its own, inherited from no folder, that allows its user everything and nobody
/// else anything.
pub fn restrict(path: &Path) -> io::Result<()> {
    let user = User::current()?;
    let access = EXPLICIT_ACCESS_W {
        grfAccessPermissions: FILE_ALL_ACCESS,
        grfAccessMode: SET_ACCESS,
        grfInheritance: NO_INHERITANCE,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_USER,
            ptstrName: user.sid().cast(),
        },
    };
    let mut acl: *mut ACL = null_mut();
    // SAFETY: one entry, read by the call alone; the list it makes is freed below.
    succeeded(unsafe { SetEntriesInAclW(1, &access, null(), &mut acl) })?;
    let list = Local(acl.cast());
    let name = wide(path);
    // SAFETY: a path ending in a nul and the list just made, which outlive the call.
    succeeded(unsafe {
        SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            list.0.cast::<ACL>(),
            null(),
        )
    })
}

/// The accounts but its user's, the system's and the administrators' that the file's access list lets read it, by
/// their names.
pub fn other_readers(path: &Path) -> io::Result<Vec<String>> {
    let user = User::current()?;
    let name = wide(path);
    let mut acl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: a path ending in a nul; the descriptor the call allocates, which holds the list, is freed below.
    succeeded(unsafe {
        GetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    })?;
    let _descriptor = Local(descriptor);
    if acl.is_null() {
        // No list at all lets everyone in.
        return Ok(vec!["Everyone".to_owned()]);
    }
    let mut size = ACL_SIZE_INFORMATION::default();
    // SAFETY: the list the descriptor holds, and a structure of the size given.
    nonzero(unsafe {
        GetAclInformation(acl, (&raw mut size).cast(), size_of::<ACL_SIZE_INFORMATION>() as u32, AclSizeInformation)
    })?;
    let mut others = Vec::new();
    for index in 0..size.AceCount {
        let mut entry: *mut c_void = null_mut();
        // SAFETY: an index below the list's count; the entry points into the list, alive with the descriptor.
        nonzero(unsafe { GetAce(acl, index, &mut entry) })?;
        let allowed = entry.cast::<ACCESS_ALLOWED_ACE>();
        // SAFETY: every entry starts with its header, and an entry of the type allowed is that structure, its SID
        // starting at its last field.
        let (header, mask, sid) =
            unsafe { ((*allowed).Header, (*allowed).Mask, (&raw mut (*allowed).SidStart).cast::<c_void>()) };
        let reads = mask & (FILE_READ_DATA | GENERIC_READ | GENERIC_ALL) != 0;
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE
            || u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0
            || !reads
        {
            continue;
        }
        // SAFETY: SIDs of the list and of the user's token, both alive.
        let anyone_else = unsafe {
            EqualSid(sid, user.sid()) == 0
                && IsWellKnownSid(sid, WinLocalSystemSid) == 0
                && IsWellKnownSid(sid, WinBuiltinAdministratorsSid) == 0
        };
        if anyone_else {
            others.push(account(sid));
        }
    }
    Ok(others)
}

/// The user who runs ff, by name, as icacls takes it.
pub fn user_name() -> io::Result<String> {
    Ok(account(User::current()?.sid()))
}

/// The user who runs ff: its process's token's user, the structure held in a buffer aligned for it.
struct User(Vec<u64>);

impl User {
    fn current() -> io::Result<User> {
        let mut token: HANDLE = null_mut();
        // SAFETY: the process's own pseudo-handle; the token opened is closed below.
        nonzero(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        let mut length = 0u32;
        // SAFETY: asked with no buffer, the call says the length it needs, and fails for that reason.
        unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length) };
        let mut buffer = vec![0u64; (length as usize).div_ceil(size_of::<u64>())];
        // SAFETY: a buffer of at least the length the call asked for.
        let read =
            nonzero(unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length) });
        // SAFETY: the token opened above.
        unsafe { CloseHandle(token) };
        read.map(|()| User(buffer))
    }

    fn sid(&self) -> PSID {
        // SAFETY: the buffer holds the TOKEN_USER the token gave, its SID inside the same buffer.
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
}

/// An account by its name, `DOMAIN\name`, or when it has no name here by its SID's text, starred as icacls takes it.
fn account(sid: PSID) -> String {
    let (mut name, mut domain) = ([0u16; 256], [0u16; 256]);
    let (mut name_length, mut domain_length) = (name.len() as u32, domain.len() as u32);
    let mut kind: SID_NAME_USE = 0;
    // SAFETY: buffers of the lengths given, which the call fills with names ending in a nul.
    let named = unsafe {
        LookupAccountSidW(
            null(),
            sid,
            name.as_mut_ptr(),
            &mut name_length,
            domain.as_mut_ptr(),
            &mut domain_length,
            &mut kind,
        )
    };
    let text =
        |buffer: &[u16], length: u32| OsString::from_wide(&buffer[..length as usize]).to_string_lossy().into_owned();
    if named != 0 {
        return match domain_length {
            0 => text(&name, name_length),
            _ => format!("{}\\{}", text(&domain, domain_length), text(&name, name_length)),
        };
    }
    let mut string: *mut u16 = null_mut();
    // SAFETY: the call allocates the text, freed below.
    if unsafe { ConvertSidToStringSidW(sid, &mut string) } == 0 {
        return "an account Windows can't name".to_owned();
    }
    let _string = Local(string.cast());
    // SAFETY: the text the call made, ending in a nul.
    let length = (0..).take_while(|&at| unsafe { *string.add(at) } != 0).count();
    // SAFETY: the length just counted, within the text.
    format!("*{}", String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(string, length) }))
}

/// What Windows allocated for a call's answer, freed when dropped.
struct Local(*mut c_void);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: memory Windows allocated with LocalAlloc for this answer, freed once.
            unsafe { LocalFree(self.0) };
        }
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain([0]).collect()
}

/// A call that answers with its error's code.
fn succeeded(code: u32) -> io::Result<()> {
    match code {
        ERROR_SUCCESS => Ok(()),
        code => Err(io::Error::from_raw_os_error(code as i32)),
    }
}

/// A call that answers zero when it fails, its error the thread's last.
fn nonzero(answer: i32) -> io::Result<()> {
    match answer {
        0 => Err(io::Error::last_os_error()),
        _ => Ok(()),
    }
}
