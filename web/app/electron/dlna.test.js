const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createDlna, didl, parseDescription, parseSsdpReply, parseUpnpTime, searchMessage, soapBody, upnpTime, tag } = require("./dlna");

const DESCRIPTION = (control) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
  <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
  <friendlyName>[TV] Bedroom &amp; More</friendlyName><manufacturer>Samsung</manufacturer><modelName>QN65S95F</modelName>
  <UDN>uuid:1234</UDN>
  <serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/rc</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>${control}</controlURL></service>
  </serviceList>
</device></root>`;

test("the search message and SSDP answers", () => {
  const message = searchMessage(2);
  assert.match(message, /^M-SEARCH \* HTTP\/1\.1\r\n/);
  assert.match(message, /ST: urn:schemas-upnp-org:device:MediaRenderer:1/);
  assert.ok(message.endsWith("\r\n\r\n"));
  const reply = parseSsdpReply("HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.20:9197/dmr\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n");
  assert.equal(reply.location, "http://192.168.1.20:9197/dmr");
  assert.equal(parseSsdpReply("NOTIFY * HTTP/1.1\r\n\r\n"), null);
});

test("a description gives the name and the control address, never one on another host", () => {
  const found = parseDescription(DESCRIPTION("/upnp/control/AVTransport1"), "http://192.168.1.20:9197/dmr");
  assert.deepEqual(found, { id: "uuid:1234", name: "[TV] Bedroom & More", model: "Samsung QN65S95F", host: "192.168.1.20", control: "http://192.168.1.20:9197/upnp/control/AVTransport1", service: "urn:schemas-upnp-org:service:AVTransport:1", rendering: "http://192.168.1.20:9197/rc", renderingService: "urn:schemas-upnp-org:service:RenderingControl:1" });
  assert.equal(parseDescription(DESCRIPTION("http://8.8.8.8/x"), "http://192.168.1.20:9197/dmr"), null, "elsewhere: refused");
  assert.equal(parseDescription("<root><device><friendlyName>Lamp</friendlyName></device></root>", "http://192.168.1.21/d"), null, "cannot play");
});

test("times and song descriptions", () => {
  assert.equal(upnpTime(201.7), "0:03:21");
  assert.equal(upnpTime(3725), "1:02:05");
  assert.equal(parseUpnpTime("00:03:21.500"), 201.5);
  assert.equal(parseUpnpTime("NOT_IMPLEMENTED"), 0);
  const meta = didl({ url: "http://192.168.1.5:47700/cast/x/audio/t1.mp3?a=1&b=2", mime: "audio/mpeg", title: "Rock & <Roll>", artist: "AC/DC", album: "High Voltage", cover: "http://h/c.jpg", seconds: 201 });
  assert.match(meta, /<dc:title>Rock &amp; &lt;Roll&gt;<\/dc:title>/);
  assert.match(meta, /protocolInfo="http-get:\*:audio\/mpeg:DLNA\.ORG_PN=MP3;/);
  assert.match(meta, /duration="0:03:21\.000"/);
  assert.match(meta, /a=1&amp;b=2/);
  // Inside the SOAP request the description is escaped once more.
  assert.match(soapBody("urn:x", "SetAVTransportURI", { CurrentURIMetaData: meta }), /&lt;DIDL-Lite/);
});

test("a renderer is told to play, pause, seek and asked where it is", async () => {
  const calls = [];
  let state = "STOPPED";
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.end(DESCRIPTION("/ctl"));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const action = /#(\w+)"/.exec(req.headers.soapaction)[1];
      calls.push({ action, body, url: req.url });
      if (action === "Play") state = "PLAYING";
      if (action === "Pause") state = "PAUSED_PLAYBACK";
      if (action === "Seek" && !body.includes("REL_TIME")) {
        res.statusCode = 500;
        res.end("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>710</errorCode><errorDescription>Seek mode not supported</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>");
        return;
      }
      const answers = {
        GetTransportInfo: `<CurrentTransportState>${state}</CurrentTransportState>`,
        GetPositionInfo: "<TrackDuration>0:03:21</TrackDuration><RelTime>0:01:02</RelTime><TrackURI>http://x/y.mp3</TrackURI>",
        GetVolume: "<CurrentVolume>35</CurrentVolume>",
        GetMute: "<CurrentMute>0</CurrentMute>",
      };
      res.end(`<s:Envelope><s:Body><u:${action}Response>${answers[action] ?? ""}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const location = `http://127.0.0.1:${server.address().port}/dmr`;
  try {
    const dlna = createDlna({ addresses: () => [] });
    const device = await dlna.addByLocation(location);
    assert.equal(device.name, "[TV] Bedroom & More");
    await dlna.load(device.id, { url: "http://192.168.1.5:47700/cast/t/audio/a.mp3", mime: "audio/mpeg", title: "Song", artist: "Band", album: "LP", cover: null, seconds: 201 });
    assert.deepEqual(calls.map((c) => c.action), ["Stop", "SetAVTransportURI", "Play"]);
    assert.match(calls[1].body, /<CurrentURI>http:\/\/192\.168\.1\.5:47700\/cast\/t\/audio\/a\.mp3<\/CurrentURI>/);
    assert.match(calls[1].body, /<InstanceID>0<\/InstanceID>/);
    assert.deepEqual(await dlna.status(device.id), { volume: 0.35, state: "PLAYING", position: 62, duration: 201, uri: "http://x/y.mp3" });
    await dlna.setVolume(device.id, 0.2);
    const set = calls.find((c) => c.action === "SetVolume");
    assert.ok(set && set.url === "/rc" && set.body.includes("<DesiredVolume>20</DesiredVolume>"), "the volume goes to RenderingControl, 0 to 100");
    assert.equal(dlna.canPreload(device.id), false);
    await dlna.pause(device.id);
    assert.equal((await dlna.status(device.id)).state, "PAUSED_PLAYBACK");
    await dlna.seek(device.id, 90);
    assert.match(calls.at(-1).body, /<Target>0:01:30<\/Target>/);
    await assert.rejects(dlna.status("uuid:nope"), /no longer found/);
    assert.equal(tag("<a:Foo x='1'>bar &amp; baz</a:Foo>", "Foo"), "bar & baz");
  } finally {
    server.close();
  }
});
