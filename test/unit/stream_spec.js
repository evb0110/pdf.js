/* Copyright 2017 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ChunkedStream,
  ChunkedStreamManager,
} from "../../src/core/chunked_stream.js";
import { Dict, Ref } from "../../src/core/primitives.js";
import { MissingDataException } from "../../src/core/core_utils.js";
import { NetworkPdfManager } from "../../src/core/pdf_manager.js";
import { PDFDataRangeTransport } from "../../src/display/api.js";
import { PDFDataTransportStream } from "../../src/display/transport_stream.js";
import { PredictorStream } from "../../src/core/predictor_stream.js";
import { Stream } from "../../src/core/stream.js";
import { XRef } from "../../src/core/xref.js";

function concatUint8Arrays(...arrays) {
  const result = new Uint8Array(
    arrays.reduce((length, array) => length + array.length, 0)
  );
  let offset = 0;
  for (const array of arrays) {
    result.set(array, offset);
    offset += array.length;
  }
  return result;
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  );
}

function buildCrossReferenceStreamPdf({ splitXRefDictionary = false } = {}) {
  const encode = value => new TextEncoder().encode(value);
  const object2 = "<< /Type /Catalog /Pages 3 0 R >>";
  const object3 = "<< /Type /Pages /Kids [] /Count 0 >>";
  const objectHeader = `2 0 3 ${object2.length + 1}\n`;
  const objectData = encode(`${objectHeader}${object2}\n${object3}\n`);
  const object1Header = encode(
    `1 0 obj\n<< /Type /ObjStm /N 2 /First ${objectHeader.length} /Length ${objectData.length} >>\nstream\n`
  );
  const object1 = concatUint8Arrays(
    object1Header,
    objectData,
    encode("endstream\nendobj\n")
  );
  const prefix = encode("%PDF-1.5\n");
  const object1Offset = prefix.length;
  const object4Offset = object1Offset + object1.length;
  const object4Trailer = encode("\nendstream\nendobj\n");
  const scanWindowBytes = 1024 * 1024;
  const headerDistance = 100;
  let fillerLength = 2 * 1024 * 1024;

  if (splitXRefDictionary) {
    const maxFillerAdjustments = 100;
    let converged = false;
    for (let iteration = 0; iteration < maxFillerAdjustments; iteration++) {
      const object4HeaderLength = encode(
        `4 0 obj\n<< /Length ${fillerLength} >>\nstream\n`
      ).length;
      const object5Offset =
        object4Offset +
        object4HeaderLength +
        fillerLength +
        object4Trailer.length;
      const boundary =
        Math.ceil((object5Offset + headerDistance) / scanWindowBytes) *
        scanWindowBytes;
      const nextFillerLength =
        boundary -
        headerDistance -
        object4Offset -
        object4HeaderLength -
        object4Trailer.length;
      if (nextFillerLength === fillerLength) {
        converged = true;
        break;
      }
      fillerLength = nextFillerLength;
    }
    if (!converged) {
      throw new Error("The XRef dictionary filler length did not converge.");
    }
  }

  const filler = new Uint8Array(fillerLength).fill(0x41);
  const object4Header = encode(
    `4 0 obj\n<< /Length ${filler.length} >>\nstream\n`
  );
  const object4 = concatUint8Arrays(object4Header, filler, object4Trailer);
  const object5Offset = object4Offset + object4.length;
  const entries = [
    [0, 0, 65535],
    [1, object1Offset, 0],
    [2, 1, 0],
    [2, 1, 1],
    [1, object4Offset, 0],
    [1, object5Offset, 0],
  ];
  const xrefData = new Uint8Array(entries.length * 7);
  const view = new DataView(xrefData.buffer);
  for (let i = 0; i < entries.length; i++) {
    const [type, value, generation] = entries[i];
    const offset = i * 7;
    xrefData[offset] = type;
    view.setUint32(offset + 1, value);
    view.setUint16(offset + 5, generation);
  }
  const xrefDictionaryPadding = splitXRefDictionary ? " ".repeat(128) : "";
  if (splitXRefDictionary) {
    const xrefMarkerOffset =
      object5Offset +
      encode("5 0 obj\n<< ").length +
      xrefDictionaryPadding.length;
    const boundary =
      Math.ceil(object5Offset / scanWindowBytes) * scanWindowBytes;
    if (
      object5Offset !== boundary - headerDistance ||
      xrefMarkerOffset <= boundary
    ) {
      throw new Error(
        "The XRef dictionary was not split across a scan window."
      );
    }
  }
  const xrefHeader = encode(
    `5 0 obj\n<< ${xrefDictionaryPadding}/Type /XRef /W [1 4 2] /Size ${entries.length} /Root 2 0 R /Length ${xrefData.length} >>\nstream\n`
  );
  const xref = concatUint8Arrays(
    xrefHeader,
    xrefData,
    encode(`\nendstream\nendobj\nstartxref\n${object5Offset}\n%%EOF\n`)
  );
  const trailingFiller = new Uint8Array(2 * 1024 * 1024).fill(0x42);
  return concatUint8Arrays(prefix, object1, object4, xref, trailingFiller);
}

function createNetworkPdfManager(data, requestedRanges) {
  const source = {
    getRangeReader(begin, end) {
      let done = false;
      return {
        read() {
          if (done) {
            return Promise.resolve({ value: undefined, done: true });
          }
          done = true;
          requestedRanges.push([begin, end]);
          const chunk = data.subarray(begin, end);
          return Promise.resolve({
            value: toArrayBuffer(chunk),
            done: false,
          });
        },
      };
    },
  };
  return new NetworkPdfManager({
    source,
    length: data.length,
    rangeChunkSize: 64 * 1024,
    disableAutoFetch: true,
    handler: { send() {} },
    docBaseUrl: null,
    docId: "chunked-xref-test",
    enableXfa: false,
    password: null,
    evaluatorOptions: {
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      canvasMaxAreaInBytes: -1,
    },
  });
}

function preloadNetworkPdf(manager, data) {
  const streamManager = manager.streamManager;
  const stream = streamManager.getStream();
  for (let begin = 0; begin < data.length; begin += stream.chunkSize) {
    const chunk = data.subarray(begin, begin + stream.chunkSize);
    streamManager.onReceiveData({
      begin,
      chunk: toArrayBuffer(chunk),
    });
  }
  return stream;
}

async function recoverCrossReferenceStream(data) {
  const requestedRanges = [];
  const manager = createNetworkPdfManager(data, requestedRanges);
  const stream = preloadNetworkPdf(manager, data);
  const xref = new XRef(stream, manager);
  const trailer = await manager.ensure(xref, "indexObjectsBounded", []);
  return { requestedRanges, stream, xref, trailer };
}

describe("stream", function () {
  describe("PredictorStream", function () {
    it("should decode simple predictor data", function () {
      const dict = new Dict();
      dict.set("Predictor", 12);
      dict.set("Colors", 1);
      dict.set("BitsPerComponent", 8);
      dict.set("Columns", 2);

      const input = new Stream(
        new Uint8Array([2, 100, 3, 2, 1, 255, 2, 1, 255]),
        0,
        9,
        dict
      );
      const predictor = new PredictorStream(input, /* length = */ 9, dict);
      const result = predictor.getBytes(6);

      expect(result).toEqual(new Uint8Array([100, 3, 101, 2, 102, 1]));
    });
  });

  describe("PDFDataTransportStream", function () {
    it("should keep pending range reads until the final chunk", async function () {
      const transport = new PDFDataRangeTransport(2, null);
      transport.requestDataRange = () => {};
      const stream = new PDFDataTransportStream({
        pdfDataRangeTransport: transport,
      });
      const rangeReader = stream.getRangeReader(0, 2);
      let doneCalled = false;
      const onDone = rangeReader.onDone;
      rangeReader.onDone = () => {
        doneCalled = true;
        onDone?.();
      };

      const firstRead = rangeReader.read();
      let secondReadResolved = false;
      const secondRead = rangeReader.read().then(result => {
        secondReadResolved = true;
        return result;
      });

      transport.onDataRange(0, new Uint8Array([1]), /* isLast = */ false);
      expect(await firstRead).toEqual({
        value: new Uint8Array([1]).buffer,
        done: false,
      });
      await Promise.resolve();
      expect(secondReadResolved).toEqual(false);
      expect(doneCalled).toEqual(false);

      transport.onDataRange(0, new Uint8Array([2]), /* isLast = */ true);
      expect(await secondRead).toEqual({
        value: new Uint8Array([2]).buffer,
        done: false,
      });
      expect(doneCalled).toEqual(true);
      expect(await rangeReader.read()).toEqual({
        value: undefined,
        done: true,
      });
    });
  });

  describe("ChunkedStream", function () {
    it("should load and read sparse ranges", function () {
      const stream = new ChunkedStream(10, 4, null);
      expect(stream.bytes.byteLength).toEqual(0);

      stream.onReceiveData(0, new Uint8Array([0, 1, 2, 3]).buffer);
      stream.onReceiveData(4, new Uint8Array([4, 5, 6, 7]).buffer);
      stream.onReceiveData(8, new Uint8Array([8, 9]).buffer);

      expect(stream.getByteRange(2, 9)).toEqual(
        new Uint8Array([2, 3, 4, 5, 6, 7, 8])
      );
      expect(stream.bytes.byteLength).toEqual(0);
    });

    it("should discard old chunks and preserve cloned ranges", function () {
      const stream = new ChunkedStream(10, 4, null);
      stream.onReceiveData(0, new Uint8Array([0, 1, 2, 3]).buffer);
      stream.onReceiveData(4, new Uint8Array([4, 5, 6, 7]).buffer);
      stream.onReceiveData(8, new Uint8Array([8, 9]).buffer);

      stream.discardChunksBefore(8);

      expect(stream.getMissingChunks()).toEqual([0, 1]);
      expect(stream.clone().getByteRange(8, 10)).toEqual(
        new Uint8Array([8, 9])
      );
    });

    it("should not retain a progressive buffer spanning multiple chunks", function () {
      const stream = new ChunkedStream(8, 4, null);
      const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
      stream.onReceiveProgressiveData(data.buffer);
      data.fill(9);

      expect(stream.getByteRange(0, data.length)).toEqual(
        new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
      );
    });

    it("should reject a discarded chunk cached by a stream clone", function () {
      const stream = new ChunkedStream(12, 4, null);
      stream.onReceiveData(4, new Uint8Array([4, 5, 6, 7]).buffer);
      stream.onReceiveData(8, new Uint8Array([8, 9, 10, 11]).buffer);

      const clone = stream.clone();
      clone.ensureByte(4);
      stream.discardChunksBefore(8);

      expect(() => clone.ensureByte(4)).toThrowError(MissingDataException);
    });

    it("should recover compressed objects after bounded xref recovery", async function () {
      const data = buildCrossReferenceStreamPdf();
      const { requestedRanges, stream, xref, trailer } =
        await recoverCrossReferenceStream(data);

      expect(trailer.getRaw("Root")).toEqual(Ref.get(2, 0));
      expect(xref.getEntry(2)).toEqual({ offset: 1, gen: 0 });
      expect(stream._storedChunks.size).toBeLessThan(stream.numChunks);
      expect(stream._storedChunks.has(0)).toBeFalse();

      const root = await xref.fetchAsync(Ref.get(2, 0));

      expect(root.get("Type").name).toEqual("Catalog");
      expect(root.get("Pages").get("Count")).toEqual(0);
      expect(requestedRanges.length).toBeGreaterThanOrEqual(2);
      expect(requestedRanges.some(([begin]) => begin === 0)).toBeTrue();
      expect(
        requestedRanges.some(([begin]) => begin >= stream.chunkSize)
      ).toBeTrue();
      expect(stream._storedChunks.size).toBeLessThan(stream.numChunks);
    });

    it("should recover an XRef stream split across scan windows", async function () {
      const data = buildCrossReferenceStreamPdf({
        splitXRefDictionary: true,
      });
      const { requestedRanges, stream, xref, trailer } =
        await recoverCrossReferenceStream(data);

      expect(trailer.getRaw("Root")).toEqual(Ref.get(2, 0));
      expect(xref.getEntry(2)).toEqual({ offset: 1, gen: 0 });
      expect(stream._storedChunks.size).toBeLessThan(stream.numChunks);
      expect(stream._storedChunks.has(0)).toBeFalse();

      const root = await xref.fetchAsync(Ref.get(2, 0));

      expect(root.get("Type").name).toEqual("Catalog");
      expect(root.get("Pages").get("Count")).toEqual(0);
      expect(requestedRanges.length).toBeGreaterThanOrEqual(2);
      expect(requestedRanges.some(([begin]) => begin === 0)).toBeTrue();
      expect(
        requestedRanges.some(([begin]) => begin >= stream.chunkSize)
      ).toBeTrue();
      expect(stream._storedChunks.size).toBeLessThan(stream.numChunks);
    });

    it("should preserve an existing object with a newer generation", async function () {
      const firstObjectOffset = "%PDF-1.4\n".length;
      const data = new TextEncoder().encode(
        "%PDF-1.4\n" +
          "2 1 obj\n" +
          "<< /Type /Catalog /Pages << /Count 0 >> >>\n" +
          "endobj\n" +
          "2 0 obj\n" +
          "<< /Invalid\n" +
          "trailer\n" +
          "<< /Root << /Type /Catalog /Pages << /Count 0 >> >> >>\n" +
          "2 1 obj\n" +
          "<< /Broken\n"
      );
      const manager = new NetworkPdfManager({
        source: {
          getRangeReader(begin, end) {
            let done = false;
            return {
              read: () => {
                if (done) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                done = true;
                return Promise.resolve({
                  value: toArrayBuffer(data.subarray(begin, end)),
                  done: false,
                });
              },
            };
          },
        },
        length: data.length,
        rangeChunkSize: data.length,
        disableAutoFetch: true,
        handler: { send() {} },
        docBaseUrl: null,
        docId: "duplicate-object-test",
        enableXfa: false,
        password: null,
        evaluatorOptions: {
          isOffscreenCanvasSupported: false,
          isImageDecoderSupported: false,
          canvasMaxAreaInBytes: -1,
        },
      });
      const stream = preloadNetworkPdf(manager, data);
      const xref = new XRef(stream, manager);

      await manager.ensure(xref, "indexObjectsBounded", []);

      expect(xref.entries[2]).toEqual({
        offset: firstObjectOffset,
        gen: 1,
        uncompressed: true,
      });
    });
  });

  describe("ChunkedStreamManager", function () {
    it("should align streamed range-reader chunks before storing them", async function () {
      const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const manager = new ChunkedStreamManager(
        {
          getRangeReader(begin, end) {
            let offset = begin;
            return {
              read() {
                if (offset >= end) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                const nextOffset = Math.min(offset + 3, end);
                const chunk = toArrayBuffer(data.subarray(offset, nextOffset));
                offset = nextOffset;
                return Promise.resolve({ value: chunk, done: false });
              },
            };
          },
        },
        {
          length: data.length,
          rangeChunkSize: 4,
          disableAutoFetch: true,
          msgHandler: { send() {} },
        }
      );

      await manager.requestRange(0, data.length);

      expect(manager.stream.getByteRange(0, data.length)).toEqual(data);
    });

    it("should retain complete chunks returned beyond the requested range", async function () {
      const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      const manager = new ChunkedStreamManager(
        {
          getRangeReader(begin) {
            let done = false;
            return {
              read() {
                if (done) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                done = true;
                return Promise.resolve({
                  value: toArrayBuffer(data.subarray(begin)),
                  done: false,
                });
              },
            };
          },
        },
        {
          length: data.length,
          rangeChunkSize: 4,
          disableAutoFetch: true,
          msgHandler: { send() {} },
        }
      );

      await manager.requestRange(0, 8);

      expect(manager.stream.getByteRange(0, data.length)).toEqual(data);
    });

    it("should cap grouped range requests at 8 MiB", function () {
      const manager = new ChunkedStreamManager(
        {},
        {
          length: 10 * 1024 * 1024,
          rangeChunkSize: 1024 * 1024,
          disableAutoFetch: false,
          msgHandler: null,
        }
      );

      expect(
        manager.groupChunks(Array.from({ length: 10 }, (_, i) => i))
      ).toEqual([
        { beginChunk: 0, endChunk: 8 },
        { beginChunk: 8, endChunk: 10 },
      ]);
    });
  });
});
