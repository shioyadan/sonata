import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

// 再抽出用の同期wrapperも全文文字列を作らず、共通解析器へ行を渡す。
export function* evidenceLines(fileName: string, prefixBytes = Infinity) {
    const fd = fs.openSync(fileName, "r");
    const buffer = Buffer.alloc(64 * 1024),
        decoder = new StringDecoder("utf8");
    let pending = "",
        read = 0;
    try {
        while (read < prefixBytes) {
            const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, prefixBytes - read), null);
            if (!count) break;
            read += count;
            pending += decoder.write(buffer.subarray(0, count));
            let start = 0,
                end: number;
            while ((end = pending.indexOf("\n", start)) >= 0) {
                yield pending.slice(start, end).replace(/\r$/, "");
                start = end + 1;
            }
            pending = pending.slice(start);
        }
        pending += decoder.end();
        if (pending && read < prefixBytes) yield pending.replace(/\r$/, "");
    } finally {
        fs.closeSync(fd);
    }
}
