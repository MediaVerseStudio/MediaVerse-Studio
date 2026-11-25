const test = require("node:test");
const assert = require("node:assert/strict");
const { castQuery, createFramer, decodeMessage, devicesFrom, encodeMessage, encodeName, frame, parseAnswer, NS } = require("./googlecast");

test("a Cast message reads back as written, and messages split across chunks are framed", () => {
  const bytes = encodeMessage({ destination: "web-5", namespace: NS.media, data: { type: "LOAD", requestId: 7, title: "Ünïcode ♪" } });
  const read = decodeMessage(bytes);
  assert.equal(read.source, "sender-0");
  assert.equal(read.destination, "web-5");
  assert.equal(read.namespace, NS.media);
  assert.deepEqual(JSON.parse(read.text), { type: "LOAD", requestId: 7, title: "Ünïcode ♪" });
  // Known bytes: field 1 (protocol version 0) comes first as 08 00.
  assert.deepEqual([...bytes.subarray(0, 2)], [0x08, 0x00]);
  const got = [];
  const feed = createFramer((m) => got.push(decodeMessage(m).destination));
  const stream = Buffer.concat([frame(encodeMessage({ destination: "a", namespace: "n", data: {} })), frame(encodeMessage({ destination: "b", namespace: "n", data: {} }))]);
  feed(stream.subarray(0, 5));
  feed(stream.subarray(5, 30));
  feed(stream.subarray(30));
  assert.deepEqual(got, ["a", "b"]);
  assert.throws(() => decodeMessage(Buffer.from([0x12, 0x50, 0x41])), /truncated/);
});

test("the mDNS question, and devices read from an answer", () => {
  const query = castQuery();
  assert.equal(query.readUInt16BE(4), 1, "one question");
  assert.ok(query.includes(Buffer.from("_googlecast")));
  // An answer: PTR -> instance, SRV -> port and host, TXT -> name and model, A -> address (with name compression).
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0]);
  const service = encodeName("_googlecast._tcp.local");
  const record = (name, type, data) => {
    const meta = Buffer.alloc(10);
    meta.writeUInt16BE(type, 0);
    meta.writeUInt16BE(1, 2);
    meta.writeUInt32BE(120, 4);
    meta.writeUInt16BE(data.length, 8);
    return Buffer.concat([name, meta, data]);
  };
  const instance = encodeName("Den-TV-077570._googlecast._tcp.local");
  const hostName = encodeName("077570.local");
  const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x1f, 0x49]), hostName]); // port 8009
  const txtEntries = ["id=0123456789ab", "fn=Den TV", "md=Smart TV Pro"].map((e) => Buffer.concat([Buffer.from([Buffer.byteLength(e)]), Buffer.from(e)]));
  const answer = Buffer.concat([
    header,
    record(service, 12, instance),
    record(instance, 33, srv),
    record(instance, 16, Buffer.concat(txtEntries)),
    record(Buffer.from([0xc0, 12 + service.length + 10 + instance.length + instance.length + 10 + 6]), 1, Buffer.from([192, 168, 68, 75])),
  ]);
  const records = parseAnswer(answer);
  assert.deepEqual(records.map((r) => r.type), ["PTR", "SRV", "TXT", "A"]);
  assert.equal(records[3].name, "077570.local", "a compressed name is followed");
  assert.deepEqual(devicesFrom(records, "192.168.68.75"), [{ id: "cast:0123456789ab", name: "Den TV", model: "Smart TV Pro", host: "192.168.68.75", port: 8009 }]);
  assert.deepEqual(devicesFrom(records.slice(0, 3), "8.8.8.8"), [], "only home-network devices");
});
