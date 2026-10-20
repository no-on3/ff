-- L1 tests for ff.lua. hack/k8s/test-logging-filter.sh runs them in the Fluent Bit image that runs the filter,
-- with its LuaJIT. Any LuaJIT runs them too:
--   FF_LOG_LINES_PER_SECOND=3 FF_LOG_BYTES_PER_SECOND=20000 luajit deploy/k8s/logging/fluent-bit/test/ff_test.lua
-- ff.lua keeps its state between calls, as in Fluent Bit, so each test uses namespaces, pods and seconds of
-- its own.
assert(tonumber(os.getenv("FF_LOG_LINES_PER_SECOND")) == 3 and tonumber(os.getenv("FF_LOG_BYTES_PER_SECOND")) == 20000,
  "run with FF_LOG_LINES_PER_SECOND=3 FF_LOG_BYTES_PER_SECOND=20000")
dofile((debug.getinfo(1, "S").source:match("^@(.*/)test/") or "./") .. "ff.lua")

local passed, failed = 0, 0

local function test(name, body)
  local ok, err = pcall(body)
  if ok then
    passed = passed + 1
    print("ok   " .. name)
  else
    failed = failed + 1
    print("FAIL " .. name .. "\n     " .. tostring(err))
  end
end

local function eq(actual, expected, what)
  if actual ~= expected then
    error(string.format("%s: expected %s, got %s", what, tostring(expected), tostring(actual)), 2)
  end
end

-- A record as the tail input and the kubernetes filter make it.
local function line(ns, pod, fn, message, stream)
  return {
    log = message,
    stream = stream or "stdout",
    logtag = "F",
    time = "2026-10-17T10:00:00.000000000Z",
    kubernetes = { namespace_name = ns, pod_name = pod, container_name = "function",
      labels = { ["ff.dev/function-id"] = fn, ["app.kubernetes.io/name"] = "ff-function" } },
  }
end

local function send(ns, pod, fn, at, message, stream)
  local code, timestamp, out = ff("kube.var.log.containers.x.log", at, line(ns, pod, fn, message, stream))
  return code, out, timestamp
end

-- The request IDs a pod's lines get, in order; "-" for none.
local function tags(ns, pod, fn, from, messages)
  local got = {}
  for i, message in ipairs(messages) do
    local code, out = send(ns, pod, fn, from + i, message)
    eq(code, 2, "kept: " .. message)
    got[#got + 1] = out.request_id or "-"
  end
  return table.concat(got, " ")
end

local function tick(at)
  local code, timestamp, notices = ff("ff.tick", at, { ff_tick = true })
  if code == 2 then table.sort(notices, function(a, b) return a.message < b.message end) end
  return code, notices, timestamp
end

local function main()
  test("keeps the namespace, pod, function, stream and message, and nothing else", function()
    local code, out, timestamp = send("ff-t-a", "fn-1-abc", "f-1", 10.25, "hello", "stderr")
    eq(code, 2, "code")
    eq(timestamp, 10.25, "the line's own time")
    local keys = {}
    for key in pairs(out) do keys[#keys + 1] = key end
    table.sort(keys)
    eq(table.concat(keys, ","), "function_id,message,namespace,pod,stream", "fields")
    eq(out.namespace .. " " .. out.pod .. " " .. out.function_id .. " " .. out.stream .. " " .. out.message,
      "ff-t-a fn-1-abc f-1 stderr hello", "values")
  end)

  test("takes the namespace, the pod and the function from the file's name when the pod's metadata is missing", function()
    local pod = "fn-3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f-7d9f8b6c5-x2x9q"
    local tag = "kube.var.log.containers." .. pod .. "_ff-t-tagged_function-" .. string.rep("a", 64) .. ".log"
    local code, _, out = ff(tag, 15.5, { log = "written as the pod went", stream = "stdout" })
    eq(code, 2, "code")
    eq(out.namespace .. " " .. out.pod .. " " .. out.function_id, "ff-t-tagged " .. pod .. " 3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f", "fields")
  end)

  test("takes the function from the pod's name when its labels are missing", function()
    local record = line("ff-t-a", "fn-f-13-6b8c7d9f5-k2m4p", nil, "no labels")
    record.kubernetes.labels = nil
    local code, _, out = ff("kube.var.log.containers.x.log", 16.5, record)
    eq(code, 2, "code")
    eq(out.function_id, "f-13", "function ID")
  end)

  test("gives a pod's lines the call from its START to its REPORT", function()
    eq(tags("ff-t-a", "fn-2-abc", "f-2", 20, {
      "cold start",
      "START RequestId: r1 Version: $LATEST",
      "hello",
      '{"level":"error","msg":"function error","requestId":"r1"}',
      "END RequestId: r1",
      "REPORT RequestId: r1\tDuration: 1.00 ms\tBilled Duration: 1 ms\tMemory Size: 128 MB\tMax Memory Used: 60 MB",
      "between calls",
      "START RequestId: r2 Version: $LATEST",
      "second call",
    }), "- r1 r1 r1 r1 r1 - r2 r2", "request IDs")
  end)

  test("keeps each pod's call apart", function()
    send("ff-t-a", "fn-3-one", "f-3", 40.1, "START RequestId: one Version: $LATEST")
    send("ff-t-a", "fn-3-two", "f-3", 41.1, "START RequestId: two Version: $LATEST")
    local _, a = send("ff-t-a", "fn-3-one", "f-3", 42.1, "from one")
    local _, b = send("ff-t-a", "fn-3-two", "f-3", 43.1, "from two")
    send("ff-t-a", "fn-3-one", "f-3", 44.1, "REPORT RequestId: one\tDuration: 1.00 ms")
    local _, c = send("ff-t-a", "fn-3-two", "f-3", 45.1, "two still")
    eq(a.request_id .. " " .. b.request_id .. " " .. c.request_id, "one two two", "request IDs")
  end)

  test("counts a marker only at the start of a line", function()
    eq(tags("ff-t-a", "fn-4-abc", "f-4", 50, {
      "START RequestId: r4 Version: $LATEST",
      "print START RequestId: fake Version: $LATEST",
      " REPORT RequestId: r4",
      "REPORT RequestId: r4\tDuration: 1.00 ms",
      "after",
    }), "r4 r4 r4 r4 -", "request IDs")
  end)

  test("takes the call from its END when reading began inside it", function()
    eq(tags("ff-t-a", "fn-5-abc", "f-5", 60, {
      "inside a call",
      "END RequestId: r5",
      "on stderr, late",
      "REPORT RequestId: r5\tDuration: 1.00 ms",
      "after",
    }), "- r5 r5 r5 -", "request IDs")
  end)

  test("keeps 3 lines a second per namespace, by the lines' own second, and other namespaces' apart", function()
    local codes = {}
    for i = 1, 5 do codes[#codes + 1] = (send("ff-t-flood", "fn-6-abc", "f-6", 200 + i / 10, "flood " .. i)) end
    for i = 1, 3 do codes[#codes + 1] = (send("ff-t-quiet", "fn-7-abc", "f-7", 200 + i / 10, "quiet " .. i)) end
    codes[#codes + 1] = (send("ff-t-flood", "fn-6-abc", "f-6", 201.1, "next second"))
    codes[#codes + 1] = (send("ff-t-flood", "fn-6-abc", "f-6", 200.9, "a backlog line of the full second"))
    codes[#codes + 1] = (send("ff-t-flood", "fn-6-abc", "f-6", 201.2, "next second, 2"))
    eq(table.concat(codes, " "), "2 2 2 -1 -1 2 2 2 2 -1 2", "codes")
  end)

  test("counts the runtime's own lines too, so printing markers gets past nothing", function()
    local codes = {}
    for i = 1, 4 do codes[#codes + 1] = (send("ff-t-forge", "fn-8-abc", "f-8", 250.5, "START RequestId: x" .. i .. " Version: 1")) end
    eq(table.concat(codes, " "), "2 2 2 -1", "codes")
  end)

  test("keeps 20,000 bytes a second per namespace", function()
    local big = string.rep("b", 8000)
    local codes = {}
    codes[#codes + 1] = (send("ff-t-bytes", "fn-9-abc", "f-9", 300.1, big))
    codes[#codes + 1] = (send("ff-t-bytes", "fn-9-abc", "f-9", 300.2, big))
    codes[#codes + 1] = (send("ff-t-bytes", "fn-9-abc", "f-9", 300.3, big)) -- 24,000 bytes: over
    codes[#codes + 1] = (send("ff-t-bytes", "fn-9-abc", "f-9", 300.4, string.rep("s", 4000))) -- 20,000: fits
    eq(table.concat(codes, " "), "2 2 -1 2", "codes")
  end)

  test("brings out, once a second is two seconds past, one notice per function and second with its count", function()
    -- Second 200: 3 of f-6's lines dropped above. Second 500: two functions of one namespace.
    for i = 1, 3 do send("ff-t-two", "fn-10-abc", "f-10", 500 + i / 10, "f-10 line " .. i) end
    send("ff-t-two", "fn-11-abc", "f-11", 500.5, "f-11 line 1")
    send("ff-t-two", "fn-11-abc", "f-11", 500.6, "f-11 line 2")
    send("ff-t-two", "fn-10-abc", "f-10", 500.7, "f-10 line 4")

    local early = tick(202.9) -- second 200 is not two seconds past yet
    eq(early, -1, "a tick at 202.9")
    local code, notices, timestamp = tick(203.0)
    eq(code, 2, "a tick at 203")
    eq(timestamp, 203.0, "the notice's time, the tick's")
    eq(#notices, 1, "notices at 203")
    local n = notices[1]
    eq(n.namespace .. " " .. n.function_id .. " " .. n.stream, "ff-t-flood f-6 ff", "the notice's fields")
    eq(n.message, "FF dropped 3 of this function's log lines written at 1970-01-01 00:03:20 UTC: its account wrote more than 3 lines, or 20000 bytes, in that second.", "the notice")
    eq(n.request_id, nil, "the notice's request ID")
    eq((tick(203.5)), -1, "the same notice again")

    code, notices = tick(503)
    eq(code, 2, "a tick at 503")
    local said = {}
    for _, notice in ipairs(notices) do said[#said + 1] = notice.namespace .. " " .. notice.function_id .. " " .. notice.message:match("dropped (%d+)") end
    table.sort(said)
    -- f-8's forged marker (second 250) and the 24,000 bytes (second 300) are counted too.
    eq(table.concat(said, "; "), "ff-t-bytes f-9 1; ff-t-forge f-8 1; ff-t-two f-10 1; ff-t-two f-11 2", "notices at 503")
    eq((tick(504)), -1, "a tick with nothing to say")
  end)

  test("cuts a line past 16,384 bytes at the start of a character", function()
    local cases = {
      { "ascii", string.rep("a", 20000), string.rep("a", 16384) },
      { "2-byte é", string.rep("é", 9000), string.rep("é", 8192) },
      { "3-byte €, whose 5,462nd starts at byte 16,384", string.rep("€", 7000), string.rep("€", 5461) },
      { "4-byte emoji", string.rep("😀", 5000), string.rep("😀", 4096) },
      { "one byte past, after 16,383 ASCII", string.rep("a", 16383) .. "😀", string.rep("a", 16383) },
    }
    for i, case in ipairs(cases) do
      local code, out = send("ff-t-cut", "fn-12-abc", "f-12", 600 + i, case[2])
      eq(code, 2, case[1] .. ": code")
      eq(out.message, case[3] .. " …[truncated]", case[1])
    end
    local exact = string.rep("x", 16384)
    local _, out = send("ff-t-cut", "fn-12-abc", "f-12", 610, exact)
    eq(out.message, exact, "16,384 bytes: kept whole")
  end)

  print(string.format("%d passed, %d failed", passed, failed))
  return failed == 0 and 0 or 1
end

-- In Fluent Bit, the dummy input's one record calls run(), and the result ends Fluent Bit.
function run()
  os.exit(main())
end

if arg then os.exit(main()) end
