//! The names an export gives what it declares: CloudFormation's logical IDs, of letters and digits
//! alone, each once in a template; and a function's name on Lambda, by Lambda's rule.

use std::collections::HashSet;

use crate::config::is_function_name;

/// The logical IDs a template has given, so that none is given twice.
#[derive(Default)]
pub struct LogicalIds {
    taken: HashSet<String>,
}

impl LogicalIds {
    /// An ID of the name's words, each begun with a capital, then what it is: `send-receipts`, a
    /// function, is `SendReceiptsFunction`; another name of the same words gets `2` after it.
    pub fn give(&mut self, name: &str, kind: &str) -> String {
        let base = format!("{}{kind}", words(name));
        let mut id = base.clone();
        let mut next = 2;
        while !self.taken.insert(id.clone()) {
            id = format!("{base}{next}");
            next += 1;
        }
        id
    }
}

/// The name's letters and digits, each word begun with a capital, as a logical ID takes them; a word
/// in capitals alone, as a variable's often is, in small letters after its first.
pub fn words(name: &str) -> String {
    name.split(|c: char| !c.is_ascii_alphanumeric())
        .flat_map(|word| {
            let shouted = !word.chars().any(|c| c.is_ascii_lowercase());
            word.chars().enumerate().map(move |(at, c)| match (at, shouted) {
                (0, _) => c.to_ascii_uppercase(),
                (_, true) => c.to_ascii_lowercase(),
                (_, false) => c,
            })
        })
        .collect()
}

/// Each function's name on Lambda, in the order given: its own, as every name made since FF took
/// Lambda's rule is; a name from before, outside it, with `_` for each character the rule refuses and
/// cut to 64, a number after it if another function has that name already.
pub fn lambda_names(names: &[&str]) -> Vec<String> {
    let mut taken: HashSet<String> =
        names.iter().filter(|name| is_function_name(name)).map(|name| name.to_string()).collect();
    names
        .iter()
        .map(|name| {
            if is_function_name(name) {
                return name.to_string();
            }
            let base: String = name
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .take(64)
                .collect();
            let mut renamed = base.clone();
            let mut next = 2;
            while !taken.insert(renamed.clone()) {
                let suffix = format!("_{next}");
                renamed = format!("{}{suffix}", &base[..base.len().min(64 - suffix.len())]);
                next += 1;
            }
            renamed
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_logical_id_is_the_names_words_with_capitals_then_what_it_is_and_never_twice() {
        let mut ids = LogicalIds::default();

        assert_eq!(ids.give("send-receipts", "Function"), "SendReceiptsFunction");
        assert_eq!(ids.give("orders", "Queue"), "OrdersQueue");
        assert_eq!(ids.give("orders", "Function"), "OrdersFunction");
        assert_eq!(ids.give("send_receipts", "Function"), "SendReceiptsFunction2");
        assert_eq!(ids.give("Send.Receipts", "Function"), "SendReceiptsFunction3");
        assert_eq!(ids.give("apiV2", "Function"), "ApiV2Function");
        assert_eq!(ids.give("send-receipts DATABASE_URL", ""), "SendReceiptsDatabaseUrl");
        assert_eq!(ids.give("2fa", "Function"), "2faFunction");
        assert_eq!(ids.give("été", "Function"), "TFunction");
    }

    #[test]
    fn a_name_from_before_lambdas_rule_is_made_one_it_takes_and_kept_apart_from_the_others() {
        let long = "a".repeat(70);
        assert_eq!(
            lambda_names(&["send-receipts", "my orders", "my_orders", "my.orders", &long]),
            ["send-receipts", "my_orders_2", "my_orders", "my_orders_3", &"a".repeat(64)]
        );
    }
}
