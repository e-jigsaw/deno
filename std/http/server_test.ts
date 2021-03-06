// Copyright 2010 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Ported from
// https://github.com/golang/go/blob/master/src/net/http/responsewrite_test.go

const { Buffer, test } = Deno;
import { TextProtoReader } from "../textproto/mod.ts";
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrowsAsync,
  AssertionError
} from "../testing/asserts.ts";
import {
  Response,
  ServerRequest,
  writeResponse,
  serve,
  readRequest,
  parseHTTPVersion,
  writeTrailers
} from "./server.ts";
import {
  BufReader,
  BufWriter,
  ReadLineResult,
  UnexpectedEOFError
} from "../io/bufio.ts";
import { delay, deferred } from "../util/async.ts";
import { StringReader } from "../io/readers.ts";

function assertNotEOF<T extends {}>(val: T | Deno.EOF): T {
  assertNotEquals(val, Deno.EOF);
  return val as T;
}

interface ResponseTest {
  response: Response;
  raw: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

type Handler = () => void;

const mockConn = {
  localAddr: {
    transport: "tcp",
    hostname: "",
    port: 0
  },
  remoteAddr: {
    transport: "tcp",
    hostname: "",
    port: 0
  },
  rid: -1,
  closeRead: (): void => {},
  closeWrite: (): void => {},
  read: async (): Promise<number | Deno.EOF> => {
    return 0;
  },
  write: async (): Promise<number> => {
    return -1;
  },
  close: (): void => {}
};

const responseTests: ResponseTest[] = [
  // Default response
  {
    response: {},
    raw: "HTTP/1.1 200 OK\r\n" + "content-length: 0" + "\r\n\r\n"
  },
  // Empty body with status
  {
    response: {
      status: 404
    },
    raw: "HTTP/1.1 404 Not Found\r\n" + "content-length: 0" + "\r\n\r\n"
  },
  // HTTP/1.1, chunked coding; empty trailer; close
  {
    response: {
      status: 200,
      body: new Buffer(new TextEncoder().encode("abcdef"))
    },

    raw:
      "HTTP/1.1 200 OK\r\n" +
      "transfer-encoding: chunked\r\n\r\n" +
      "6\r\nabcdef\r\n0\r\n\r\n"
  }
];

test(async function responseWrite(): Promise<void> {
  for (const testCase of responseTests) {
    const buf = new Buffer();
    const bufw = new BufWriter(buf);
    const request = new ServerRequest();
    request.w = bufw;

    request.conn = mockConn as Deno.Conn;

    await request.respond(testCase.response);
    assertEquals(buf.toString(), testCase.raw);
    await request.done;
  }
});

test(async function requestContentLength(): Promise<void> {
  // Has content length
  {
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("content-length", "5");
    const buf = new Buffer(enc.encode("Hello"));
    req.r = new BufReader(buf);
    assertEquals(req.contentLength, 5);
  }
  // No content length
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < shortText.length) {
      const chunkSize = Math.min(maxChunkSize, shortText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${shortText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(enc.encode(chunksData));
    req.r = new BufReader(buf);
    assertEquals(req.contentLength, null);
  }
});

test(async function requestBodyWithContentLength(): Promise<void> {
  {
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("content-length", "5");
    const buf = new Buffer(enc.encode("Hello"));
    req.r = new BufReader(buf);
    const body = dec.decode(await Deno.readAll(req.body));
    assertEquals(body, "Hello");
  }

  // Larger than internal buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("Content-Length", "5000");
    const buf = new Buffer(enc.encode(longText));
    req.r = new BufReader(buf);
    const body = dec.decode(await Deno.readAll(req.body));
    assertEquals(body, longText);
  }
});

test(async function requestBodyWithTransferEncoding(): Promise<void> {
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < shortText.length) {
      const chunkSize = Math.min(maxChunkSize, shortText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${shortText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(enc.encode(chunksData));
    req.r = new BufReader(buf);
    const body = dec.decode(await Deno.readAll(req.body));
    assertEquals(body, shortText);
  }

  // Larger than internal buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < longText.length) {
      const chunkSize = Math.min(maxChunkSize, longText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${longText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(enc.encode(chunksData));
    req.r = new BufReader(buf);
    const body = dec.decode(await Deno.readAll(req.body));
    assertEquals(body, longText);
  }
});

test(async function requestBodyReaderWithContentLength(): Promise<void> {
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("content-length", "" + shortText.length);
    const buf = new Buffer(enc.encode(shortText));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(6);
    let offset = 0;
    while (offset < shortText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = dec.decode(readBuf.subarray(0, nread as number));
      assertEquals(shortText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }

  // Larger than given buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("Content-Length", "5000");
    const buf = new Buffer(enc.encode(longText));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(1000);
    let offset = 0;
    while (offset < longText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = dec.decode(readBuf.subarray(0, nread as number));
      assertEquals(longText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }
});

test(async function requestBodyReaderWithTransferEncoding(): Promise<void> {
  {
    const shortText = "Hello";
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < shortText.length) {
      const chunkSize = Math.min(maxChunkSize, shortText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${shortText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(enc.encode(chunksData));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(6);
    let offset = 0;
    while (offset < shortText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = dec.decode(readBuf.subarray(0, nread as number));
      assertEquals(shortText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }

  // Larger than internal buf
  {
    const longText = "1234\n".repeat(1000);
    const req = new ServerRequest();
    req.headers = new Headers();
    req.headers.set("transfer-encoding", "chunked");
    let chunksData = "";
    let chunkOffset = 0;
    const maxChunkSize = 70;
    while (chunkOffset < longText.length) {
      const chunkSize = Math.min(maxChunkSize, longText.length - chunkOffset);
      chunksData += `${chunkSize.toString(16)}\r\n${longText.substr(
        chunkOffset,
        chunkSize
      )}\r\n`;
      chunkOffset += chunkSize;
    }
    chunksData += "0\r\n\r\n";
    const buf = new Buffer(enc.encode(chunksData));
    req.r = new BufReader(buf);
    const readBuf = new Uint8Array(1000);
    let offset = 0;
    while (offset < longText.length) {
      const nread = await req.body.read(readBuf);
      assertNotEOF(nread);
      const s = dec.decode(readBuf.subarray(0, nread as number));
      assertEquals(longText.substr(offset, nread as number), s);
      offset += nread as number;
    }
    const nread = await req.body.read(readBuf);
    assertEquals(nread, Deno.EOF);
  }
});

test(async function writeUint8ArrayResponse(): Promise<void> {
  const shortText = "Hello";

  const body = new TextEncoder().encode(shortText);
  const res: Response = { body };

  const buf = new Deno.Buffer();
  await writeResponse(buf, res);

  const decoder = new TextDecoder("utf-8");
  const reader = new BufReader(buf);

  let r: ReadLineResult;
  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), "HTTP/1.1 200 OK");
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), `content-length: ${shortText.length}`);
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(r.line.byteLength, 0);
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), shortText);
  assertEquals(r.more, false);

  const eof = await reader.readLine();
  assertEquals(eof, Deno.EOF);
});

test(async function writeStringResponse(): Promise<void> {
  const body = "Hello";

  const res: Response = { body };

  const buf = new Deno.Buffer();
  await writeResponse(buf, res);

  const decoder = new TextDecoder("utf-8");
  const reader = new BufReader(buf);

  let r: ReadLineResult;
  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), "HTTP/1.1 200 OK");
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), `content-length: ${body.length}`);
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(r.line.byteLength, 0);
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), body);
  assertEquals(r.more, false);

  const eof = await reader.readLine();
  assertEquals(eof, Deno.EOF);
});

test(async function writeStringReaderResponse(): Promise<void> {
  const shortText = "Hello";

  const body = new StringReader(shortText);
  const res: Response = { body };

  const buf = new Deno.Buffer();
  await writeResponse(buf, res);

  const decoder = new TextDecoder("utf-8");
  const reader = new BufReader(buf);

  let r: ReadLineResult;
  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), "HTTP/1.1 200 OK");
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), "transfer-encoding: chunked");
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(r.line.byteLength, 0);
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), shortText.length.toString());
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), shortText);
  assertEquals(r.more, false);

  r = assertNotEOF(await reader.readLine());
  assertEquals(decoder.decode(r.line), "0");
  assertEquals(r.more, false);
});

test("writeResponse with trailer", async () => {
  const w = new Buffer();
  const body = new StringReader("Hello");
  await writeResponse(w, {
    status: 200,
    headers: new Headers({
      "transfer-encoding": "chunked",
      trailer: "deno,node"
    }),
    body,
    trailers: () => new Headers({ deno: "land", node: "js" })
  });
  const ret = w.toString();
  const exp = [
    "HTTP/1.1 200 OK",
    "transfer-encoding: chunked",
    "trailer: deno,node",
    "",
    "5",
    "Hello",
    "0",
    "",
    "deno: land",
    "node: js",
    "",
    ""
  ].join("\r\n");
  assertEquals(ret, exp);
});

test(async function readRequestError(): Promise<void> {
  const input = `GET / HTTP/1.1
malformedHeader
`;
  const reader = new BufReader(new StringReader(input));
  let err;
  try {
    await readRequest(mockConn as Deno.Conn, reader);
  } catch (e) {
    err = e;
  }
  assert(err instanceof Error);
  assertEquals(err.message, "malformed MIME header line: malformedHeader");
});

// Ported from Go
// https://github.com/golang/go/blob/go1.12.5/src/net/http/request_test.go#L377-L443
// TODO(zekth) fix tests
test(async function testReadRequestError(): Promise<void> {
  const testCases = [
    {
      in: "GET / HTTP/1.1\r\nheader: foo\r\n\r\n",
      headers: [{ key: "header", value: "foo" }]
    },
    {
      in: "GET / HTTP/1.1\r\nheader:foo\r\n",
      err: UnexpectedEOFError
    },
    { in: "", err: Deno.EOF },
    {
      in: "HEAD / HTTP/1.1\r\nContent-Length:4\r\n\r\n",
      err: "http: method cannot contain a Content-Length"
    },
    {
      in: "HEAD / HTTP/1.1\r\n\r\n",
      headers: []
    },
    // Multiple Content-Length values should either be
    // deduplicated if same or reject otherwise
    // See Issue 16490.
    {
      in:
        "POST / HTTP/1.1\r\nContent-Length: 10\r\nContent-Length: 0\r\n\r\n" +
        "Gopher hey\r\n",
      err: "cannot contain multiple Content-Length headers"
    },
    {
      in:
        "POST / HTTP/1.1\r\nContent-Length: 10\r\nContent-Length: 6\r\n\r\n" +
        "Gopher\r\n",
      err: "cannot contain multiple Content-Length headers"
    },
    {
      in:
        "PUT / HTTP/1.1\r\nContent-Length: 6 \r\nContent-Length: 6\r\n" +
        "Content-Length:6\r\n\r\nGopher\r\n",
      headers: [{ key: "Content-Length", value: "6" }]
    },
    {
      in: "PUT / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 6 \r\n\r\n",
      err: "cannot contain multiple Content-Length headers"
    },
    // Setting an empty header is swallowed by textproto
    // see: readMIMEHeader()
    // {
    //   in: "POST / HTTP/1.1\r\nContent-Length:\r\nContent-Length: 3\r\n\r\n",
    //   err: "cannot contain multiple Content-Length headers"
    // },
    {
      in: "HEAD / HTTP/1.1\r\nContent-Length:0\r\nContent-Length: 0\r\n\r\n",
      headers: [{ key: "Content-Length", value: "0" }]
    },
    {
      in:
        "POST / HTTP/1.1\r\nContent-Length:0\r\ntransfer-encoding: " +
        "chunked\r\n\r\n",
      headers: [],
      err: "http: Transfer-Encoding and Content-Length cannot be send together"
    }
  ];
  for (const test of testCases) {
    const reader = new BufReader(new StringReader(test.in));
    let err;
    let req: ServerRequest | Deno.EOF | undefined;
    try {
      req = await readRequest(mockConn as Deno.Conn, reader);
    } catch (e) {
      err = e;
    }
    if (test.err === Deno.EOF) {
      assertEquals(req, Deno.EOF);
    } else if (typeof test.err === "string") {
      assertEquals(err.message, test.err);
    } else if (test.err) {
      assert(err instanceof (test.err as typeof UnexpectedEOFError));
    } else {
      assert(req instanceof ServerRequest);
      assert(test.headers);
      assertEquals(err, undefined);
      assertNotEquals(req, Deno.EOF);
      for (const h of test.headers) {
        assertEquals(req.headers.get(h.key), h.value);
      }
    }
  }
});

// Ported from https://github.com/golang/go/blob/f5c43b9/src/net/http/request_test.go#L535-L565
test({
  name: "[http] parseHttpVersion",
  fn(): void {
    const testCases = [
      { in: "HTTP/0.9", want: [0, 9] },
      { in: "HTTP/1.0", want: [1, 0] },
      { in: "HTTP/1.1", want: [1, 1] },
      { in: "HTTP/3.14", want: [3, 14] },
      { in: "HTTP", err: true },
      { in: "HTTP/one.one", err: true },
      { in: "HTTP/1.1/", err: true },
      { in: "HTTP/-1.0", err: true },
      { in: "HTTP/0.-1", err: true },
      { in: "HTTP/", err: true },
      { in: "HTTP/1,0", err: true }
    ];
    for (const t of testCases) {
      let r, err;
      try {
        r = parseHTTPVersion(t.in);
      } catch (e) {
        err = e;
      }
      if (t.err) {
        assert(err instanceof Error, t.in);
      } else {
        assertEquals(err, undefined);
        assertEquals(r, t.want, t.in);
      }
    }
  }
});

test({
  name: "[http] destroyed connection",
  async fn(): Promise<void> {
    // Runs a simple server as another process
    const p = Deno.run({
      args: [Deno.execPath(), "--allow-net", "http/testdata/simple_server.ts"],
      stdout: "piped"
    });

    try {
      const r = new TextProtoReader(new BufReader(p.stdout!));
      const s = await r.readLine();
      assert(s !== Deno.EOF && s.includes("server listening"));

      let serverIsRunning = true;
      p.status()
        .then((): void => {
          serverIsRunning = false;
        })
        .catch((_): void => {}); // Ignores the error when closing the process.

      await delay(100);

      // Reqeusts to the server and immediately closes the connection
      const conn = await Deno.connect({ port: 4502 });
      await conn.write(new TextEncoder().encode("GET / HTTP/1.0\n\n"));
      conn.close();

      // Waits for the server to handle the above (broken) request
      await delay(100);

      assert(serverIsRunning);
    } finally {
      // Stops the sever.
      p.close();
    }
  }
});

test({
  name: "[http] serveTLS",
  async fn(): Promise<void> {
    // Runs a simple server as another process
    const p = Deno.run({
      args: [
        Deno.execPath(),
        "--allow-net",
        "--allow-read",
        "http/testdata/simple_https_server.ts"
      ],
      stdout: "piped"
    });

    try {
      const r = new TextProtoReader(new BufReader(p.stdout!));
      const s = await r.readLine();
      assert(s !== Deno.EOF && s.includes("server listening"));

      let serverIsRunning = true;
      p.status()
        .then((): void => {
          serverIsRunning = false;
        })
        .catch((_): void => {}); // Ignores the error when closing the process.

      // Requests to the server and immediately closes the connection
      const conn = await Deno.connectTLS({
        hostname: "localhost",
        port: 4503,
        certFile: "http/testdata/tls/RootCA.pem"
      });
      await Deno.writeAll(
        conn,
        new TextEncoder().encode("GET / HTTP/1.0\r\n\r\n")
      );
      const res = new Uint8Array(100);
      const nread = assertNotEOF(await conn.read(res));
      conn.close();
      const resStr = new TextDecoder().decode(res.subarray(0, nread));
      assert(resStr.includes("Hello HTTPS"));
      assert(serverIsRunning);
    } finally {
      // Stops the sever.
      p.close();
    }
  }
});

test({
  name: "[http] close server while iterating",
  async fn(): Promise<void> {
    const server = serve(":8123");
    const nextWhileClosing = server[Symbol.asyncIterator]().next();
    server.close();
    assertEquals(await nextWhileClosing, { value: undefined, done: true });

    const nextAfterClosing = server[Symbol.asyncIterator]().next();
    assertEquals(await nextAfterClosing, { value: undefined, done: true });
  }
});

// TODO(kevinkassimo): create a test that works on Windows.
// The following test is to ensure that if an error occurs during respond
// would result in connection closed. (such that fd/resource is freed).
// On *nix, a delayed second attempt to write to a CLOSE_WAIT connection would
// receive a RST and thus trigger an error during response for us to test.
// We need to find a way to similarly trigger an error on Windows so that
// we can test if connection is closed.
if (Deno.build.os !== "win") {
  test({
    name: "[http] respond error handling",
    async fn(): Promise<void> {
      const connClosedPromise = deferred();
      const serverRoutine = async (): Promise<void> => {
        let reqCount = 0;
        const server = serve(":8124");
        // @ts-ignore
        const serverRid = server.listener["rid"];
        let connRid = -1;
        for await (const req of server) {
          connRid = req.conn.rid;
          reqCount++;
          await Deno.readAll(req.body);
          await connClosedPromise;
          try {
            await req.respond({
              body: new TextEncoder().encode("Hello World")
            });
            await delay(100);
            req.done = deferred();
            // This duplicate respond is to ensure we get a write failure from the
            // other side. Our client would enter CLOSE_WAIT stage after close(),
            // meaning first server .send (.respond) after close would still work.
            // However, a second send would fail under RST, which is similar
            // to the scenario where a failure happens during .respond
            await req.respond({
              body: new TextEncoder().encode("Hello World")
            });
          } catch {
            break;
          }
        }
        server.close();
        const resources = Deno.resources();
        assert(reqCount === 1);
        // Server should be gone
        assert(!(serverRid in resources));
        // The connection should be destroyed
        assert(!(connRid in resources));
      };
      const p = serverRoutine();
      const conn = await Deno.connect({
        hostname: "127.0.0.1",
        port: 8124
      });
      await Deno.writeAll(
        conn,
        new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")
      );
      conn.close(); // abruptly closing connection before response.
      // conn on server side enters CLOSE_WAIT state.
      connClosedPromise.resolve();
      await p;
    }
  });
}

test("writeTrailer", async () => {
  const w = new Buffer();
  await writeTrailers(
    w,
    new Headers({ "transfer-encoding": "chunked", trailer: "deno,node" }),
    new Headers({ deno: "land", node: "js" })
  );
  assertEquals(w.toString(), "deno: land\r\nnode: js\r\n\r\n");
});

test("writeTrailer should throw", async () => {
  const w = new Buffer();
  await assertThrowsAsync(
    () => {
      return writeTrailers(w, new Headers(), new Headers());
    },
    Error,
    'must have "trailer"'
  );
  await assertThrowsAsync(
    () => {
      return writeTrailers(w, new Headers({ trailer: "deno" }), new Headers());
    },
    Error,
    "only allowed"
  );
  for (const f of ["content-length", "trailer", "transfer-encoding"]) {
    await assertThrowsAsync(
      () => {
        return writeTrailers(
          w,
          new Headers({ "transfer-encoding": "chunked", trailer: f }),
          new Headers({ [f]: "1" })
        );
      },
      AssertionError,
      "prohibited"
    );
  }
  await assertThrowsAsync(
    () => {
      return writeTrailers(
        w,
        new Headers({ "transfer-encoding": "chunked", trailer: "deno" }),
        new Headers({ node: "js" })
      );
    },
    AssertionError,
    "Not trailer"
  );
});
