import { assertName } from '../node-to-fsa/util';
import { assertType } from '../crud/util';
import { FLAG } from 'memfs/lib/consts/FLAG';
import { newExistsError, newFile404Error, newFolder404Error, newMissingError } from '../fsa-to-crud/util';
import type { FsPromisesApi } from 'memfs/lib/node/types';
import type * as crud from '../crud/types';
import type { IDirent, IFileHandle } from 'memfs/lib/node/types/misc';

export interface NodeCrudOptions {
  readonly fs: FsPromisesApi;
  readonly dir: string;
  readonly separator?: string;
}

export class NodeCrud implements crud.CrudApi {
  protected readonly fs: FsPromisesApi;
  protected readonly dir: string;
  protected readonly separator: string;

  public constructor(protected readonly options: NodeCrudOptions) {
    this.separator = options.separator ?? '/';
    let dir = options.dir;
    const last = dir[dir.length - 1];
    if (last !== this.separator) dir = dir + this.separator;
    this.dir = dir;
    this.fs = options.fs;
  }

  protected async checkDir(collection: crud.CrudCollection): Promise<string> {
    const dir = this.dir + (collection.length ? collection.join(this.separator) + this.separator : '');
    const fs = this.fs;
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) throw newFolder404Error(collection);
      return dir;
    } catch (error) {
      if (error && typeof error === 'object') {
        switch (error.code) {
          case 'ENOENT':
          case 'ENOTDIR':
            throw newFolder404Error(collection);
        }
      }
      throw error;
    }
  }

  public readonly put = async (
    collection: crud.CrudCollection,
    id: string,
    data: Uint8Array,
    options?: crud.CrudPutOptions,
  ): Promise<void> => {
    assertType(collection, 'put', 'crudfs');
    assertName(id, 'put', 'crudfs');
    const dir = this.dir + (collection.length ? collection.join(this.separator) + this.separator : '');
    const fs = this.fs;
    if (dir.length > 1) await fs.mkdir(dir, { recursive: true });
    const filename = dir + id;
    const throwIf = options?.throwIf;
    let pos = options?.pos;
    let flags = 0;
    if (typeof pos === 'undefined') flags = flags | FLAG.O_TRUNC;
    if (throwIf) {
      if (throwIf === 'exists') flags = flags | FLAG.O_CREAT | FLAG.O_EXCL;
      else if (throwIf === 'missing') flags = flags | FLAG.O_RDWR;
    } else flags = flags | FLAG.O_RDWR | FLAG.O_CREAT;
    let handle: IFileHandle | undefined;
    try {
      handle = await fs.open(filename, flags);
    } catch (error) {
      switch (throwIf) {
        case 'exists': {
          if (error && typeof error === 'object' && error.code === 'EEXIST') throw newExistsError();
        }
        case 'missing': {
          if (error && typeof error === 'object' && error.code === 'ENOENT') throw newMissingError();
        }
      }
      throw error;
    }
    switch (typeof pos) {
      case 'undefined': {
        await handle.write(data);
        break;
      }
      case 'number': {
        if (pos === -1) {
          const stats = await handle.stat();
          pos = stats.size as number;
        }
        await handle.write(data, 0, data.byteLength, pos);
        break;
      }
      default: {
        throw new Error(`Invalid position: ${pos}`);
      }
    }
  };

  public readonly get = async (collection: crud.CrudCollection, id: string): Promise<Uint8Array> => {
    assertType(collection, 'get', 'crudfs');
    assertName(id, 'get', 'crudfs');
    const dir = await this.checkDir(collection);
    const filename = dir + id;
    const fs = this.fs;
    try {
      const buf = (await fs.readFile(filename)) as Buffer;
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (error) {
      if (error && typeof error === 'object') {
        switch (error.code) {
          case 'ENOENT':
            throw newFile404Error(collection, id);
        }
      }
      throw error;
    }
  };

  public readonly del = async (collection: crud.CrudCollection, id: string, silent?: boolean): Promise<void> => {
    assertType(collection, 'del', 'crudfs');
    assertName(id, 'del', 'crudfs');
    try {
      const dir = await this.checkDir(collection);
      const filename = dir + id;
      await this.fs.unlink(filename);
    } catch (error) {
      if (!!silent) return;
      if (error && typeof error === 'object') {
        switch (error.code) {
          case 'ENOENT':
            throw newFile404Error(collection, id);
        }
      }
      throw error;
    }
  };

  public readonly info = async (collection: crud.CrudCollection, id?: string): Promise<crud.CrudResourceInfo> => {
    assertType(collection, 'info', 'crudfs');
    if (id) {
      assertName(id, 'info', 'crudfs');
      await this.checkDir(collection);
      try {
        const stats = await this.fs.stat(this.dir + collection.join(this.separator) + this.separator + id);
        if (!stats.isFile()) throw newFile404Error(collection, id);
        return {
          type: 'resource',
          id,
          size: <number>stats.size,
          modified: <number>stats.mtimeMs,
        };
      } catch (error) {
        if (error && typeof error === 'object') {
          switch (error.code) {
            case 'ENOENT':
              throw newFile404Error(collection, id);
          }
        }
        throw error;
      }
    } else {
      await this.checkDir(collection);
      try {
        const stats = await this.fs.stat(this.dir + collection.join(this.separator));
        if (!stats.isDirectory()) throw newFolder404Error(collection);
        return {
          type: 'collection',
          id: '',
        };
      } catch (error) {
        if (error && typeof error === 'object') {
          switch (error.code) {
            case 'ENOENT':
            case 'ENOTDIR':
              throw newFolder404Error(collection);
          }
        }
        throw error;
      }
    }
  };

  public readonly drop = async (collection: crud.CrudCollection, silent?: boolean): Promise<void> => {
    assertType(collection, 'drop', 'crudfs');
    try {
      const dir = await this.checkDir(collection);
      const isRoot = dir === this.dir;
      if (isRoot) {
        const list = (await this.fs.readdir(dir)) as string[];
        for (const entry of list) await this.fs.rmdir(dir + entry, { recursive: true });
      } else {
        await this.fs.rmdir(dir, { recursive: true });
      }
    } catch (error) {
      if (!silent) throw error;
    }
  };

  public readonly scan = async function* (
    collection: crud.CrudCollection,
  ): AsyncIterableIterator<crud.CrudCollectionEntry> {
    assertType(collection, 'scan', 'crudfs');
    const dir = await this.checkDir(collection);
    const dirents = (await this.fs.readdir(dir, { withFileTypes: true })) as IDirent[];
    for await (const entry of dirents) {
      if (entry.isFile()) {
        yield {
          type: 'resource',
          id: '' + entry.name,
        };
      } else if (entry.isDirectory()) {
        yield {
          type: 'collection',
          id: '' + entry.name,
        };
      }
    }
  };

  public readonly list = async (collection: crud.CrudCollection): Promise<crud.CrudCollectionEntry[]> => {
    const entries: crud.CrudCollectionEntry[] = [];
    for await (const entry of this.scan(collection)) entries.push(entry);
    return entries;
  };

  public readonly from = async (collection: crud.CrudCollection): Promise<crud.CrudApi> => {
    assertType(collection, 'from', 'crudfs');
    const dir = this.dir + (collection.length ? collection.join(this.separator) + this.separator : '');
    const fs = this.fs;
    if (dir.length > 1) await fs.mkdir(dir, { recursive: true });
    await this.checkDir(collection);
    return new NodeCrud({
      dir,
      fs: this.fs,
      separator: this.separator,
    });
  };
}
