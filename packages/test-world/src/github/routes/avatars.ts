import { deflateSync } from "node:zlib";
import { route } from "../router.ts";

// avatars.githubusercontent.com, served under `/avatars` of the fake: `GET /avatars/u/{id}` answers
// a small PNG for any numeric id, a different colour per id, as GitHub's identicons differ.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8×8 single-colour PNG. */
export function avatarPng(id: number): Buffer {
  const size = 8;
  const rgb = [(id * 47) % 256, (id * 89) % 256, (id * 151) % 256];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.from([0, ...Array.from({ length: size }, () => rgb).flat()])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

export const avatarRoutes = [
  route("GET", "/avatars/u/:id", ({ params }) => {
    if (!/^\d+$/.test(params.id ?? "")) return new Response("Not Found", { status: 404 });
    return new Response(new Uint8Array(avatarPng(Number(params.id))), {
      status: 200,
      headers: { "content-type": "image/png", "cache-control": "max-age=300" },
    });
  }),
];
