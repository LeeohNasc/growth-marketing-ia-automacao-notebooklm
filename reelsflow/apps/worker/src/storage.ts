import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Abstração do storage para o worker; o adaptador local é usado nos testes. */
export interface StorageAdapter {
  download(objectPath: string, destFile: string): Promise<void>;
  upload(objectPath: string, file: string, contentType: string): Promise<void>;
  remove(objectPaths: string[]): Promise<void>;
  /** Lista recursivamente os objetos sob um prefixo (ex.: "{workspace}/"). */
  list(prefix: string): Promise<string[]>;
  exists(objectPath: string): Promise<boolean>;
}

export class SupabaseStorage implements StorageAdapter {
  private readonly client: SupabaseClient;
  constructor(url: string, serviceKey: string, private readonly bucket = "media") {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async download(objectPath: string, destFile: string) {
    // URL assinada + streaming para disco: não carrega o vídeo inteiro na memória.
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(objectPath, 300);
    if (error || !data) throw new Error(`signed url failed: ${error?.message ?? "unknown"}`);
    const res = await fetch(data.signedUrl);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(destFile));
  }

  async upload(objectPath: string, file: string, contentType: string) {
    const body = await readFile(file);
    const { error } = await this.client.storage.from(this.bucket).upload(objectPath, body, { contentType, upsert: true });
    if (error) throw new Error(`upload failed: ${error.message}`);
  }

  async remove(objectPaths: string[]) {
    for (let i = 0; i < objectPaths.length; i += 100) {
      const { error } = await this.client.storage.from(this.bucket).remove(objectPaths.slice(i, i + 100));
      if (error) throw new Error(`remove failed: ${error.message}`);
    }
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await this.client.storage.from(this.bucket).list(dir, { limit: 1000, offset });
        if (error) throw new Error(`list failed: ${error.message}`);
        for (const item of data ?? []) {
          const full = dir ? `${dir}/${item.name}` : item.name;
          if (item.id === null) await walk(full); // pasta
          else out.push(full);
        }
        if (!data || data.length < 1000) break;
      }
    };
    await walk(prefix.replace(/\/$/, ""));
    return out;
  }

  async exists(objectPath: string) {
    const dir = path.posix.dirname(objectPath);
    const name = path.posix.basename(objectPath);
    const { data, error } = await this.client.storage.from(this.bucket).list(dir, { search: name, limit: 10 });
    if (error) throw new Error(`exists failed: ${error.message}`);
    return (data ?? []).some((o) => o.name === name);
  }
}

/** Storage em disco local (testes e desenvolvimento offline). */
export class LocalStorage implements StorageAdapter {
  constructor(private readonly root: string) {}
  private resolve(p: string) {
    const full = path.resolve(this.root, p);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("path escapes storage root");
    return full;
  }
  async download(objectPath: string, destFile: string) {
    await copyFile(this.resolve(objectPath), destFile);
  }
  async upload(objectPath: string, file: string) {
    const dest = this.resolve(objectPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(file, dest);
  }
  async put(objectPath: string, data: Buffer | string) {
    const dest = this.resolve(objectPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }
  async remove(objectPaths: string[]) {
    for (const p of objectPaths) await rm(this.resolve(p), { force: true });
  }
  async list(prefix: string) {
    const base = this.resolve(prefix.replace(/\/$/, "") || ".");
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else out.push(path.relative(this.root, full).split(path.sep).join("/"));
      }
    };
    await walk(base);
    return out;
  }
  async exists(objectPath: string) {
    try {
      await stat(this.resolve(objectPath));
      return true;
    } catch {
      return false;
    }
  }
}
