-- FF's log filter for Fluent Bit (client-readiness plan P-42, ADR 0005). For each line a function container
-- writes, it does three things:
--   * the fields the store keeps: the namespace (the account), the pod, the function, the stream, and the
--     call the line belongs to. An instance runs one call at a time (D14), so a call's lines run from its
--     pod's START line to its REPORT line;
--   * the limit: each namespace keeps LINES lines, and BYTES bytes, a second, counted by the lines' own
--     time, so that a backlog read after a restart keeps each second's budget. Lines over it are dropped and
--     counted;
--   * the cut: a line over MAX bytes is cut at the start of a character, and says so.
-- Once a second, the dummy input's tick brings out one line per function and second in which lines were
-- dropped, saying how many, and forgets old state. Fluent Bit runs this in one Lua state per filter, so the
-- inputs must not be threaded.

local LINES = tonumber(os.getenv("FF_LOG_LINES_PER_SECOND")) or 2000
local BYTES = tonumber(os.getenv("FF_LOG_BYTES_PER_SECOND")) or 1048576
local MAX = 16384
local TRUNCATED = " …[truncated]"
-- A call's tag is forgotten an hour after its START if no REPORT came (its pod died), and a second's counts
-- ten minutes after it.
local CALL_TTL = 3600
local COUNT_TTL = 600

local calls = {} -- pod -> { id = the call's request ID, second = when it started }
local lines, bytes = {}, {} -- "namespace second" -> lines and bytes kept
local dropped = {} -- "namespace\tfunction\tsecond" -> lines dropped

-- At most MAX bytes, ending before a character's first byte: UTF-8 continuation bytes are 0x80 to 0xBF,
-- and a character has three at most.
local function cut(message)
  if #message <= MAX then return message end
  local n = MAX
  for _ = 1, 3 do
    local b = string.byte(message, n + 1)
    if b < 0x80 or b > 0xBF then break end
    n = n - 1
  end
  return string.sub(message, 1, n) .. TRUNCATED
end

-- Without the pod's metadata, when the API server can't be reached or the pod went before its lines were
-- read, the kubernetes filter adds nothing, but the file's name still says where a line comes from:
-- kube.var.log.containers.<pod>_<namespace>_<container>-<container ID>.log. A function's pods are named
-- fn-<function ID>-<ReplicaSet hash>-<pod hash>.
local function fromTag(tag)
  return string.match(tag, "^kube%.var%.log%.containers%.([^_]+)_([^_]+)_")
end

-- The tick: a notice for each function and second whose dropped lines are counted, once that second is two
-- seconds past. A backlog's later lines for the same second get a notice of their own.
local function tick(timestamp)
  local now = math.floor(timestamp)
  local notices = {}
  for key, n in pairs(dropped) do
    local ns, fn, second = string.match(key, "^(.-)\t(.-)\t(%d+)$")
    second = tonumber(second)
    if second < now - 2 then
      notices[#notices + 1] = {
        namespace = ns,
        function_id = fn ~= "" and fn or nil,
        stream = "ff",
        message = string.format(
          "FF dropped %d of this function's log lines written at %s UTC: its account wrote more than %d lines, or %d bytes, in that second.",
          n, os.date("!%Y-%m-%d %H:%M:%S", second), LINES, BYTES),
      }
      dropped[key] = nil
    end
  end
  for key in pairs(lines) do
    if tonumber(string.match(key, " (%d+)$")) < now - COUNT_TTL then
      lines[key], bytes[key] = nil, nil
    end
  end
  for pod, call in pairs(calls) do
    if call.second < now - CALL_TTL then calls[pod] = nil end
  end
  if #notices == 0 then return -1, timestamp, {} end
  return 2, timestamp, notices
end

function ff(tag, timestamp, record)
  if record["ff_tick"] then return tick(timestamp) end

  local k = record["kubernetes"] or {}
  local labels = k["labels"] or {}
  local tagPod, tagNs = fromTag(tag)
  local ns = k["namespace_name"] or tagNs or "unknown"
  local pod = k["pod_name"] or tagPod or "unknown"
  local out = {
    namespace = ns,
    pod = pod,
    function_id = labels["ff.dev/function-id"] or string.match(pod, "^fn%-(.+)%-%w+%-%w+$"),
    stream = record["stream"],
    message = cut(record["log"] or ""),
  }

  -- Only a line that starts with the runtime's marker counts, so a handler printing one mid-line changes
  -- nothing. END sets the call too, for a collector that started reading inside it.
  local kind, id = string.match(out.message, "^(%u+) RequestId: (%S+)")
  if kind == "START" or kind == "END" then
    out.request_id = id
    calls[pod] = { id = id, second = math.floor(timestamp) }
  elseif kind == "REPORT" then
    out.request_id = id
    calls[pod] = nil
  elseif calls[pod] then
    out.request_id = calls[pod].id
  end

  -- The runtime's own lines count too: a handler could print its markers to get past the limit.
  local second = math.floor(timestamp)
  local key = ns .. " " .. second
  local kept, size = (lines[key] or 0) + 1, (bytes[key] or 0) + #out.message
  if kept > LINES or size > BYTES then
    local d = ns .. "\t" .. (out.function_id or "") .. "\t" .. second
    dropped[d] = (dropped[d] or 0) + 1
    return -1, timestamp, record
  end
  lines[key], bytes[key] = kept, size
  return 2, timestamp, out
end
