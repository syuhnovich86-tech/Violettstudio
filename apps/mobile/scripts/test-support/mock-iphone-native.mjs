import { createHash, randomUUID as uuid } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync, openSync, closeSync, readSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const Platform = { OS: 'ios' };
export const CryptoDigestAlgorithm = { SHA256: 'sha256' };
export const randomUUID = uuid;
export async function digestStringAsync(_, text) { return createHash('sha256').update(text).digest('hex'); }
export const NetworkStateType = { WIFI: 'WIFI', ETHERNET: 'ETHERNET', CELLULAR: 'CELLULAR' };
export async function getNetworkStateAsync() { return { type: 'WIFI', isConnected: true, isInternetReachable: true }; }
export const BackgroundTaskResult = { Success: 'success', Failed: 'failed' };
let registered = false;
export async function registerTaskAsync() { registered = true; }
export async function unregisterTaskAsync() { registered = false; }
export async function isTaskRegisteredAsync() { return registered; }
export function isTaskDefined() { return false; }
export function defineTask() {}
export const MediaType = { IMAGE: 'image', VIDEO: 'video' };
export const MediaSubtype = { LIVE_PHOTO: 'livePhoto' };
export const AssetField = { MEDIA_TYPE: 'mediaType', CREATION_TIME: 'creationTime' };
export const AssetUriVersion = { ORIGINAL: 'original' };
export async function getPermissionsAsync() { return { granted: true, accessPrivileges: 'all' }; }
export const requestPermissionsAsync = getPermissionsAsync;
export class Query {
  constructor() { this.start = 0; this.max = 100; }
  within() { return this; } orderBy() { return this; }
  offset(n) { this.start = n; return this; } limit(n) { this.max = n; return this; }
  async exeForMetadata() { return globalThis.__assets.slice(this.start, this.start + this.max); }
}
export class Asset {
  constructor(id) { this.id = id; }
  async getUri() { return pathToFileURL(globalThis.__assetPaths[this.id]).href; }
  async getLivePhotoVideoUri() { return pathToFileURL(globalThis.__assetPaths[this.id + '-live']).href; }
}
export const Paths = { cache: process.env.VIOLETTA_TEST_TMP };
function pathOf(value) { return value.startsWith('file:') ? fileURLToPath(value) : value; }
export class File {
  constructor(...parts) { this.path = parts.length === 1 ? pathOf(parts[0]) : join(...parts); this.uri = pathToFileURL(this.path).href; }
  get exists() { return existsSync(this.path); } get size() { return statSync(this.path).size; }
  create() { writeFileSync(this.path, ''); } write(bytes) { writeFileSync(this.path, bytes); } delete() { unlinkSync(this.path); }
  open() {
    const fd = openSync(this.path, 'r'); let offset = 0;
    return { set offset(value) { offset = value; }, get offset() { return offset; }, async readBytes(length) { const buf = Buffer.alloc(length); const count = readSync(fd, buf, 0, length, offset); offset += count; return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + count)); }, close() { closeSync(fd); } };
  }
}
export const FileSystemUploadType = { BINARY_CONTENT: 0 };
export const FileSystemSessionType = { BACKGROUND: 0 };
export async function deleteAsync(uri) { try { unlinkSync(pathOf(uri)); } catch {} }
export function createUploadTask(url, uri, options) {
  return { async cancelAsync() {}, async uploadAsync() {
    const response = await fetch(url, { method: options.httpMethod, headers: options.headers, body: readFileSync(pathOf(uri)) });
    const body = await response.text();
    if (globalThis.__dropAfterSend) { globalThis.__dropAfterSend = false; throw new Error('synthetic disconnect after server accepted chunk'); }
    return { status: response.status, body };
  } };
}
