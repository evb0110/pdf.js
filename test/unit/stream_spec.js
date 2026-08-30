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
import { Dict } from "../../src/core/primitives.js";
import { PredictorStream } from "../../src/core/predictor_stream.js";
import { Stream } from "../../src/core/stream.js";

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
  });

  describe("ChunkedStreamManager", function () {
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
