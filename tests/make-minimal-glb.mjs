import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = process.argv[2];
if (!output) throw new Error('Usage: node tests/make-minimal-glb.mjs /path/to/scene.glb');

const positions = new Float32Array([
  -1, 0, 0,
   1, 0, 0,
   0, 1.5, 0,
]);
const binary = Buffer.from(positions.buffer);
const document = {
  asset: { version: '2.0', generator: 'UE5 HTML5 Exporter test fixture' },
  scene: 0,
  scenes: [{ name: 'Verified browser fixture', nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, 0, 0], max: [1, 1.5, 0] }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length, target: 34962 }],
  buffers: [{ byteLength: binary.length }],
};

const jsonSource = Buffer.from(JSON.stringify(document));
const jsonPadding = Buffer.alloc((4 - (jsonSource.length % 4)) % 4, 0x20);
const json = Buffer.concat([jsonSource, jsonPadding]);
const binaryPadding = Buffer.alloc((4 - (binary.length % 4)) % 4);
const bin = Buffer.concat([binary, binaryPadding]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(json.length, 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(bin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);

mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([header, jsonHeader, json, binHeader, bin]));
