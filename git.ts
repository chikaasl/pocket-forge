import {createHash} from 'node:crypto';
import {deflateSync, inflateSync} from 'node:zlib';

const sha1 = (data: Buffer) => createHash('sha1').update(data).digest();
const types = ['', 'commit', 'tree', 'blob', 'tag'];
const zero = '0'.repeat(40);
const flush = Buffer.from('0000');

function packet(data: string | Buffer) {
  const body = Buffer.from(data);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

function readPackets(buffer: Buffer, stopAtFlush = false) {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = Number.parseInt(buffer.toString('ascii', offset, offset + 4), 16);
    if (!Number.isFinite(length) || length === 3 || offset + length > buffer.length) break;
    offset += 4;
    if (length === 0 && stopAtFlush) break;
    if (length < 4) continue;
    lines.push(buffer.toString('utf8', offset, offset + length - 4).replace(/\n$/, ''));
    offset += length - 4;
  }
  return {lines, offset};
}

type GitObject = {type: number; data: Buffer};

export class GitStore {
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  branch: string;

  constructor(branch = 'main') {
    this.branch = branch;
  }

  store(type: number, data: Buffer) {
    const key = sha1(Buffer.concat([Buffer.from(types[type] + ' ' + data.length + '\0'), data])).toString('hex');
    this.objects.set(key, {type, data});
    return key;
  }

  resolve(ref = this.branch) {
    return this.refs.get(ref) ?? this.refs.get('refs/heads/' + ref) ?? (this.objects.has(ref) ? ref : undefined);
  }

  commitParents(key: string) {
    return [...(this.objects.get(key)?.data.toString().split('\n\n')[0] ?? '').matchAll(/^parent ([a-f0-9]{40})$/gm)].map(x => x[1]);
  }

  commitFiles(key: string | undefined) {
    const files = new Map<string, string>();
    const walk = (tree: string, prefix: string) => {
      const object = this.objects.get(tree);
      if (!object || object.type !== 2) return;
      const data = object.data;
      for (let offset = 0; offset < data.length;) {
        const space = data.indexOf(32, offset);
        const end = data.indexOf(0, space + 1);
        if (space < 0 || end < 0 || end + 21 > data.length) break;
        const name = prefix + data.toString('utf8', space + 1, end);
        const hash = data.toString('hex', end + 1, end + 21);
        if (data.toString('ascii', offset, space) === '40000') walk(hash, name + '/');
        else files.set(name, hash);
        offset = end + 21;
      }
    };
    const tree = key && this.objects.get(key)?.data.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1];
    if (tree) walk(tree, '');
    return files;
  }

  commit(files: Map<string, string>, branch: string, message: string, parent?: string) {
    const writeTree = (entries: [string, string][]): string => {
      const subdirs = new Map<string, [string, string][]>();
      const records: [string, string, string][] = [];
      for (const [path, key] of entries) {
        const slash = path.indexOf('/');
        if (slash < 0) records.push([path, '100644', key]);
        else {
          const dir = path.slice(0, slash);
          if (!subdirs.has(dir)) subdirs.set(dir, []);
          subdirs.get(dir)!.push([path.slice(slash + 1), key]);
        }
      }
      for (const [dir, members] of subdirs) records.push([dir, '40000', writeTree(members)]);
      records.sort(([a, am], [b, bm]) => Buffer.compare(Buffer.from(a + (am === '40000' ? '/' : '')), Buffer.from(b + (bm === '40000' ? '/' : ''))));
      return this.store(2, Buffer.concat(records.flatMap(([name, mode, hash]) => [Buffer.from(mode + ' ' + name + '\0'), Buffer.from(hash, 'hex')])));
    };
    const tree = writeTree([...files]);
    const person = 'Forge <forge@example.invalid> 1700000000 +0000';
    const key = this.store(1, Buffer.from('tree ' + tree + '\n' + (parent ? 'parent ' + parent + '\n' : '') +
      'author ' + person + '\ncommitter ' + person + '\n\n' + message + '\n'));
    this.refs.set('refs/heads/' + branch, key);
    return key;
  }

  ancestor(old: string, head: string) {
    const pending = [head];
    const seen = new Set<string>();
    while (pending.length) {
      const key = pending.pop()!;
      if (key === old) return true;
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(...this.commitParents(key));
    }
    return false;
  }

  unpack(pack: Buffer) {
    if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK' ||
        !sha1(pack.subarray(0, -20)).equals(pack.subarray(-20))) throw new Error('Invalid pack');
    const count = pack.readUInt32BE(8);
    if (count > 100000) throw new Error('Too many objects');
    const offsets = new Map<number, GitObject>();
    let offset = 12;
    for (let index = 0; index < count; index++) {
      const start = offset;
      let byte = pack[offset++];
      const type = (byte >> 4) & 7;
      let size = byte & 15;
      for (let shift = 4; byte & 128; shift += 7) {
        if (shift > 32) throw new Error('Bad size');
        byte = pack[offset++];
        size += (byte & 127) * 2 ** shift;
      }
      let base: GitObject | undefined;
      if (type === 6) {
        byte = pack[offset++];
        let distance = byte & 127;
        while (byte & 128) {
          byte = pack[offset++];
          distance = (distance + 1) * 128 + (byte & 127);
          if (distance > start) throw new Error('Bad delta offset');
        }
        base = offsets.get(start - distance);
      } else if (type === 7) {
        base = this.objects.get(pack.toString('hex', offset, offset + 20));
        offset += 20;
      }
      if (size > 16 * 1024 * 1024 || offset >= pack.length - 20) throw new Error('Bad object size');
      const compressed = inflateSync(pack.subarray(offset, -20), {info: true, maxOutputLength: 16 * 1024 * 1024}) as unknown as {buffer: Buffer; engine: {bytesWritten: number}};
      offset += compressed.engine.bytesWritten;
      if (compressed.buffer.length !== size) throw new Error('Wrong object size');
      if (type >= 6 && !base || !types[type] && type < 6) throw new Error('Unknown object type or delta base');
      const object = base ? {type: base.type, data: applyDelta(base.data, compressed.buffer)}
                          : {type, data: compressed.buffer};
      this.store(object.type, object.data);
      offsets.set(start, object);
    }
    if (offset !== pack.length - 20) throw new Error('Invalid pack ending');
  }

  pack(wants: string[], depth: number, haves: Set<string>, clientShallow: Set<string>) {
    const objects = new Map<string, GitObject>();
    const shallow = new Set<string>();
    const held = new Set<string>();
    const remember = (key: string) => {
      if (held.has(key)) return;
      held.add(key);
      const object = this.objects.get(key);
      if (object?.type === 1) {
        const tree = object.data.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1];
        if (tree) remember(tree);
        if (!clientShallow.has(key)) this.commitParents(key).forEach(remember);
      } else if (object?.type === 2) {
        for (let pos = 0; pos < object.data.length;) {
          const end = object.data.indexOf(0, pos);
          if (end < 0 || end + 21 > object.data.length) break;
          remember(object.data.toString('hex', end + 1, end + 21));
          pos = end + 21;
        }
      }
    };
    haves.forEach(remember);
    const walk = (key: string, remaining: number) => {
      if (objects.has(key)) return;
      if (held.has(key)) {
        if (clientShallow.has(key) && remaining > 1) this.commitParents(key).forEach(parent => walk(parent, remaining - 1));
        return;
      }
      const object = this.objects.get(key);
      if (!object) return;
      objects.set(key, object);
      const data = object.data;
      if (object.type === 1) {
        const tree = data.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1];
        if (tree) walk(tree, remaining);
        const parents = this.commitParents(key);
        if (parents.length && remaining <= 1) shallow.add(key);
        else parents.forEach(parent => walk(parent, remaining - 1));
      } else if (object.type === 2) {
        for (let pos = 0; pos < data.length;) {
          const end = data.indexOf(0, pos);
          if (end < 0 || end + 21 > data.length) break;
          walk(data.toString('hex', end + 1, end + 21), remaining);
          pos = end + 21;
        }
      } else if (object.type === 4) {
        const target = data.toString().match(/^object ([a-f0-9]{40})\n/)?.[1];
        if (target) walk(target, remaining);
      }
    };
    wants.forEach(want => walk(want, depth));
    const header = Buffer.alloc(12);
    header.write('PACK');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(objects.size, 8);
    const chunks = [header];
    for (const {type, data} of objects.values()) {
      let size = data.length;
      const prefix = [(type << 4) | (size & 15)];
      size >>= 4;
      while (size > 0) {
        prefix[prefix.length - 1] |= 128;
        prefix.push(size & 127);
        size >>= 7;
      }
      chunks.push(Buffer.from(prefix), deflateSync(data, {level: 1}));
    }
    const raw = Buffer.concat(chunks);
    return {raw: Buffer.concat([raw, sha1(raw)]), shallow};
  }

  advertise(service: string, v2: boolean) {
    if (v2 && service === 'git-upload-pack')
      return Buffer.concat(['version 2\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(packet).concat(flush));
    const receive = service === 'git-receive-pack';
    const caps = receive ? 'report-status side-band-64k delete-refs ofs-delta'
                         : 'side-band-64k shallow ofs-delta symref=HEAD:refs/heads/' + this.branch;
    const lines = [...this.refs].map(([ref, hash]) => hash + ' ' + ref);
    const head = this.resolve();
    if (head && !receive) lines.unshift(head + ' HEAD');
    if (!lines.length) lines.push(zero + ' capabilities^{}');
    lines[0] += '\0' + caps;
    return Buffer.concat([packet('# service=' + service + '\n'), flush, ...lines.map(s => packet(s + '\n')), flush]);
  }

  receive(body: Buffer) {
    const {lines, offset} = readPackets(body, true);
    let unpacked = true;
    try {
      if (offset < body.length) this.unpack(body.subarray(offset));
    } catch {
      unpacked = false;
    }
    const status = [packet('unpack ' + (unpacked ? 'ok' : 'invalid pack') + '\n')];
    let band = false;
    for (const line of lines) {
      const [command, options] = line.split('\0');
      band ||= options?.split(' ').includes('side-band-64k') ?? false;
      const [old, next, ref] = command.split(' ');
      if (!ref?.startsWith('refs/')) continue;
      const current = this.refs.get(ref) ?? zero;
      const reason = !unpacked ? 'unpacker error' : current !== old ? 'stale ref' :
        next !== zero && !this.objects.has(next) ? 'missing object' :
        old !== zero && next !== zero && !this.ancestor(old, next) ? 'non-fast-forward' : '';
      if (!reason) {
        if (next === zero) this.refs.delete(ref);
        else this.refs.set(ref, next);
      }
      status.push(packet((reason ? 'ng ' + ref + ' ' + reason : 'ok ' + ref) + '\n'));
    }
    const report = Buffer.concat([...status, flush]);
    return band ? Buffer.concat([packet(Buffer.concat([Buffer.from([1]), report])), flush]) : report;
  }

  upload(body: Buffer) {
    const {lines} = readPackets(body);
    if (lines.includes('command=ls-refs')) {
      const prefixes = lines.filter(line => line.startsWith('ref-prefix ')).map(line => line.slice(11));
      const refs = [...this.refs];
      const head = this.resolve();
      if (head) refs.unshift(['HEAD', head]);
      return Buffer.concat([
        ...refs.filter(([ref]) => !prefixes.length || prefixes.some(prefix => ref.startsWith(prefix)))
           .map(([ref, hash]) => {
             const object = this.objects.get(hash);
             const peeled = lines.includes('peel') && object?.type === 4 ? object.data.toString().match(/^object ([a-f0-9]{40})\n/)?.[1] : undefined;
             const symref = ref === 'HEAD' && lines.includes('symrefs') ? ' symref-target:refs/heads/' + this.branch : '';
             return packet(hash + ' ' + ref + symref + (peeled ? ' peeled:' + peeled : '') + '\n');
           }),
        ...(!head && lines.includes('unborn') && (!prefixes.length || prefixes.some(prefix => 'HEAD'.startsWith(prefix)))
          ? [packet('unborn HEAD symref-target:refs/heads/' + this.branch + '\n')] : []),
        flush,
      ]);
    }
    const v2 = lines.includes('command=fetch');
    const wants = lines.filter(x => x.startsWith('want ')).map(x => x.split(' ')[1]);
    const haves = new Set(lines.filter(x => x.startsWith('have ')).map(x => x.split(' ')[1]));
    const depth = Number(lines.find(x => x.startsWith('deepen '))?.slice(7) ?? Infinity);
    const clientShallow = new Set(lines.filter(line => line.startsWith('shallow ')).map(line => line.slice(8)));
    const {raw, shallow} = this.pack(wants, depth, haves, clientShallow);
    const chunks: Buffer[] = [];
    if (shallow.size) {
      if (v2) chunks.push(packet('shallow-info\n'));
      for (const hash of shallow) chunks.push(packet('shallow ' + hash + '\n'));
      chunks.push(v2 ? Buffer.from('0001') : flush);
    }
    chunks.push(packet(v2 ? 'packfile\n' : 'NAK\n'));
    if (v2 || lines.some(line => /\bside-band(?:-64k)?\b/.test(line))) {
      for (let offset = 0; offset < raw.length; offset += 16000)
        chunks.push(packet(Buffer.concat([Buffer.from([1]), raw.subarray(offset, offset + 16000)])));
      chunks.push(flush);
    } else chunks.push(raw);
    return Buffer.concat(chunks);
  }
}

function applyDelta(base: Buffer, delta: Buffer) {
  let cursor = 0;
  const size = () => {
    let result = 0;
    for (let shift = 0; cursor < delta.length && shift < 32; shift += 7) {
      const byte = delta[cursor++];
      result += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return result;
    }
    throw new Error('Invalid delta size');
  };
  if (size() !== base.length) throw new Error('Invalid delta base size');
  const length = size();
  if (length > 16 * 1024 * 1024) throw new Error('Delta output too large');
  const result = Buffer.alloc(length);
  let output = 0;
  while (cursor < delta.length) {
    const command = delta[cursor++];
    if (command & 128) {
      let offset = 0;
      let number = 0;
      for (let i = 0; i < 4; i++) if (command & (1 << i)) offset += delta[cursor++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (command & (16 << i)) number += delta[cursor++] * 2 ** (8 * i);
      number ||= 65536;
      if (offset + number > base.length || output + number > length) throw new Error('Invalid delta range');
      base.copy(result, output, offset, offset + number);
      output += number;
    } else {
      if (!command || cursor + command > delta.length || output + command > length) throw new Error('Invalid delta insert');
      delta.copy(result, output, cursor, cursor + command);
      cursor += command;
      output += command;
    }
  }
  if (output !== length) throw new Error('Incomplete delta');
  return result;
}
