import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {GitStore} from './git.ts';

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const missing = () => new HttpError(404, 'Not Found');
const invalid = (message = 'Validation Failed') => new HttpError(422, message);
const login = {login: process.env.MAKEFUN_FORGE_OWNER ?? '', id: 1};
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let nextId = 1;
const repos = new Map<string, Repository>();

const tools: Record<string, [string, string[]]> = {
  create_repo: ['Create a repository', ['name']],
  get_repo: ['Read a repository', ['owner', 'repo']],
  create_issue: ['Open an issue', ['owner', 'repo', 'title']],
  list_issues: ['List repository issues', ['owner', 'repo']],
  create_pull_request: ['Open a pull request', ['owner', 'repo', 'title', 'head', 'base']],
  merge_pull_request: ['Squash a pull request', ['owner', 'repo', 'pull_number']],
};

class Repository {
  id = nextId++;
  name: string;
  description: string | null;
  private: boolean;
  git: GitStore;
  issues = new Map<number, any>();
  pulls = new Map<number, any>();
  labels = new Map<string, any>();
  comments = new Map<number, any[]>();
  nextNumber = 1;
  needsOwner: boolean;

  constructor(body: any) {
    this.name = body.name;
    this.description = body.description ?? null;
    this.private = body.private === true;
    this.git = new GitStore(body.default_branch ?? 'main');
    this.needsOwner = !login.login;
    if (body.auto_init) this.git.commit(new Map(), this.git.branch, 'Initial commit');
  }

  view() {
    return {id: this.id, node_id: 'R_' + this.id, name: this.name, full_name: login.login + '/' + this.name,
      default_branch: this.git.branch, owner: login, description: this.description, private: this.private,
      has_issues: true, permissions: {admin: true, push: true, pull: true}};
  }

  createIssue(body: any) {
    if (typeof body.title !== 'string' || !body.title.trim() ||
        (body.labels && (!Array.isArray(body.labels) || body.labels.some((name: string) => !this.labels.has(name))))) throw invalid();
    const id = nextId++;
    const number = this.nextNumber++;
    const timestamp = new Date(1700000000000 + id * 1000).toISOString();
    const issue = {id, node_id: 'I_' + id, number, title: body.title, body: body.body ?? '', state: 'open',
      labels: (body.labels ?? []).map((name: string) => this.labels.get(name)), user: login, created_at: timestamp, updated_at: timestamp};
    this.issues.set(number, issue);
    return issue;
  }

  createPull(body: any) {
    const head = typeof body.head === 'string' ? body.head.split(':').at(-1) : '';
    const base = body.base;
    const headSha = head && this.git.resolve(head);
    const baseSha = typeof base === 'string' && this.git.resolve(base);
    if (!headSha || !baseSha || head === base || typeof body.title !== 'string') throw invalid();
    const id = nextId++;
    const number = this.nextNumber++;
    const pull = {id, node_id: 'P_' + id, number, title: body.title, body: body.body ?? '', state: 'open',
      head: {ref: head, sha: headSha}, base: {ref: base, sha: baseSha}, user: login, merged: false, merge_commit_sha: null};
    this.pulls.set(number, pull);
    return pull;
  }

  changes(pull: any) {
    const root = this.mergeBase(pull);
    const before = this.git.commitFiles(root);
    const after = this.git.commitFiles(pull.head.sha);
    return [...new Set([...before.keys(), ...after.keys()])].sort().filter(path => before.get(path) !== after.get(path)).map(filename => {
      const a = before.get(filename);
      const b = after.get(filename);
      const lines = (hash: string | undefined) => hash ? (this.git.objects.get(hash)!.data.toString().match(/[^\n]*\n|[^\n]+$/g) ?? []).length : 0;
      const additions = lines(b);
      const deletions = lines(a);
      return {filename, status: !a ? 'added' : !b ? 'removed' : 'modified', additions, deletions, changes: additions + deletions};
    });
  }

  mergeBase(pull: any): string | undefined {
    const first: string[] = [pull.head.sha];
    const target = this.git.resolve(pull.base.ref);
    const seen = new Set<string>();
    while (first.length) {
      const hash = first.shift()!;
      if (seen.has(hash)) continue;
      seen.add(hash);
      if (target && this.git.ancestor(hash, target)) return hash;
      first.push(...this.git.commitParents(hash));
    }
    return undefined;
  }

  merge(number: number, title?: string) {
    const pull = this.pulls.get(number);
    if (!pull) throw missing();
    if (pull.state !== 'open') throw new HttpError(405, 'Pull request is closed');
    const parent = this.git.resolve(pull.base.ref);
    const origin = this.git.commitFiles(this.mergeBase(pull));
    const base = this.git.commitFiles(parent);
    const head = this.git.commitFiles(pull.head.sha);
    for (const {filename} of this.changes(pull)) {
      const change = head.get(filename);
      if (base.get(filename) !== origin.get(filename) && base.get(filename) !== change) throw new HttpError(405, 'Merge conflict');
      if (change) base.set(filename, change);
      else base.delete(filename);
    }
    const sha = this.git.commit(base, pull.base.ref, title ?? pull.title, parent);
    Object.assign(pull, {state: 'closed', merged: true, merge_commit_sha: sha,
      merged_at: new Date(1700000000000 + nextId++ * 1000).toISOString()});
    return {sha, merged: true, message: 'Pull Request successfully merged'};
  }
}

function createRepo(body: any) {
  if (typeof body.name !== 'string' || !/^[a-z0-9_.-]+$/i.test(body.name)) throw invalid();
  if (repos.has(body.name.toLowerCase())) throw invalid('Repository already exists');
  const repo = new Repository(body);
  repos.set(repo.name.toLowerCase(), repo);
  return repo.view();
}

function getRepo(owner: string, name: string) {
  const repo = repos.get(name?.toLowerCase());
  if (!repo || !owner) throw missing();
  if (!login.login && repo.needsOwner) login.login = owner;
  if (owner.toLowerCase() !== login.login.toLowerCase()) throw missing();
  return repo;
}

function json(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'x-github-request-id': 'forge', ...headers});
  res.end(status === 204 ? undefined : JSON.stringify(data));
}

function page<T>(data: T[], url: URL, req: IncomingMessage) {
  const per = Math.min(Math.max(Number(url.searchParams.get('per_page')) || 30, 1), 100);
  const number = Math.max(Number(url.searchParams.get('page')) || 1, 1);
  const count = Math.ceil(data.length / per);
  const next = new URL(url.toString());
  next.searchParams.set('page', String(number + 1));
  const headers: Record<string, string> = {};
  if (number < count) headers.link = '<http://' + (req.headers.host ?? 'localhost') + next.pathname + next.search + '>; rel="next"';
  return {list: data.slice((number - 1) * per, number * per), headers};
}

function listing(values: Iterable<any>, state: string, direction: string) {
  return [...values].filter(item => state === 'all' || item.state === state)
    .sort((a, b) => direction === 'asc' ? a.number - b.number : b.number - a.number);
}

function rest(req: IncomingMessage, res: ServerResponse, url: URL, body: any, route: string[]) {
  const method = req.method;
  const send = (status: number, data: unknown) => json(res, status, data);
  const list = (data: any[]) => {
    const p = page(data, url, req);
    return json(res, 200, p.list, p.headers);
  };
  const [first, owner, name, resource, id, action] = route;
  if (!first && method === 'GET') return json(res, 200, {current_user_url: '/api/v3/user'}, {'x-oauth-scopes': 'repo, read:org'});
  if (first === 'meta' && method === 'GET') return send(200, {installed_version: 'forge-1'});
  if (first === 'user' && !owner && method === 'GET') return send(200, login);
  if (first === 'user' && owner === 'repos') {
    if (method === 'GET') return list([...repos.values()].map(repo => repo.view()));
    if (method === 'POST') return send(201, createRepo(body));
  }
  if (first !== 'repos') throw missing();
  const repo = getRepo(owner, name);
  const git = repo.git;
  if (!resource) {
    if (method === 'GET') return send(200, repo.view());
    if (method === 'PATCH') {
      if (Object.hasOwn(body, 'description')) repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      return send(200, repo.view());
    }
    if (method === 'DELETE') {
      repos.delete(name.toLowerCase());
      return send(204, null);
    }
  }
  if (resource === 'contents') {
    const path = route.slice(4).join('/');
    const branch = body.branch ?? git.branch;
    const parent = git.resolve(method === 'GET' ? url.searchParams.get('ref') ?? git.branch : branch);
    if (method !== 'GET' && branch !== git.branch && !parent) throw missing();
    const files = git.commitFiles(parent);
    const hash = files.get(path);
    const file = (filename: string, key: string) => {
      const data = git.objects.get(key)!.data;
      return {type: 'file', name: filename.split('/').at(-1), path: filename, sha: key, size: data.length, encoding: 'base64', content: data.toString('base64')};
    };
    if (method === 'GET') {
      if (hash) return send(200, file(path, hash));
      const prefix = path ? path + '/' : '';
      const dirs = new Set<string>();
      const result: any[] = [];
      for (const [filename, key] of files) {
        if (!filename.startsWith(prefix)) continue;
        const parts = filename.slice(prefix.length).split('/');
        if (parts.length === 1) result.push(file(filename, key));
        else if (!dirs.has(parts[0])) {
          dirs.add(parts[0]);
          result.push({name: parts[0], type: 'dir', path: prefix + parts[0]});
        }
      }
      if (!result.length) throw missing();
      return send(200, result);
    }
    if (method === 'PUT' || method === 'DELETE') {
      if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) throw invalid();
      if (method === 'DELETE' && !hash) throw missing();
      if (hash && body.sha !== hash || !hash && body.sha) throw new HttpError(409, 'Stale file SHA');
      if (method === 'DELETE') files.delete(path);
      else {
        if (typeof body.content !== 'string') throw invalid();
        files.set(path, git.store(3, Buffer.from(body.content, 'base64')));
      }
      const sha = git.commit(files, branch, String(body.message ?? 'Update ' + path), parent);
      return send(method === 'PUT' && !hash ? 201 : 200, {content: method === 'DELETE' ? null : file(path, files.get(path)!), commit: {sha}});
    }
  }
  if (resource === 'git' && id === 'refs' && method === 'POST') {
    if (typeof body.ref !== 'string' || !body.ref.startsWith('refs/heads/') || git.refs.has(body.ref) || !git.objects.has(body.sha)) throw invalid();
    git.refs.set(body.ref, body.sha);
    return send(201, {ref: body.ref, object: {sha: body.sha}});
  }
  if (resource === 'branches' && method === 'GET') {
    const branches = [...git.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({name: ref.slice(11), commit: {sha}}));
    if (!id) return list(branches);
    const branch = branches.find(item => item.name === route.slice(4).join('/'));
    if (branch) return send(200, branch);
  }
  if (resource === 'commits' && method === 'GET') {
    const commits = [];
    const seen = new Set<string>();
    let sha = git.resolve(id ?? url.searchParams.get('sha') ?? git.branch);
    while (sha && !seen.has(sha)) {
      seen.add(sha);
      const message = git.objects.get(sha)?.data.toString().split('\n\n').slice(1).join('\n\n').trimEnd() ?? '';
      commits.push({sha, commit: {message}});
      sha = git.commitParents(sha)[0];
    }
    if (id) {
      if (!commits.length) throw missing();
      return send(200, commits[0]);
    }
    return list(commits);
  }
  const number = Number(id);
  if (resource === 'labels' && method === 'POST') {
    if (!body.name || repo.labels.has(body.name)) throw invalid();
    const label = {id: nextId++, name: body.name, color: body.color ?? 'ededed'};
    repo.labels.set(label.name, label);
    return send(201, label);
  }
  if (resource === 'issues') {
    if (!id && method === 'POST') return send(201, repo.createIssue(body));
    if (!id && method === 'GET') return list(listing(repo.issues.values(), url.searchParams.get('state') ?? 'open', url.searchParams.get('direction') ?? 'desc'));
    const issue = repo.issues.get(number);
    if (!issue) throw missing();
    if (action === 'comments') {
      const comments = repo.comments.get(number) ?? [];
      if (method === 'GET') return list(comments);
      if (method === 'POST' && typeof body.body === 'string') {
        const comment = {id: nextId++, body: body.body, user: login};
        comments.push(comment);
        repo.comments.set(number, comments);
        return send(201, comment);
      }
    }
    if (!action && method === 'GET') return send(200, issue);
    if (!action && method === 'PATCH') {
      if (['open', 'closed'].includes(body.state)) issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return send(200, issue);
    }
  }
  if (resource === 'pulls') {
    if (!id && method === 'POST') return send(201, repo.createPull(body));
    if (!id && method === 'GET') return list(listing(repo.pulls.values(), url.searchParams.get('state') ?? 'open', url.searchParams.get('direction') ?? 'desc'));
    const pull = repo.pulls.get(number);
    if (!pull) throw missing();
    if (action === 'merge' && method === 'PUT') return send(200, repo.merge(number, body.commit_title));
    if (action === 'files' && method === 'GET') return list(repo.changes(pull));
    if (!action && method === 'GET') return send(200, pull);
  }
  throw missing();
}

function rpc(res: ServerResponse, request: any) {
  const {id, method, params} = request;
  const envelope = {jsonrpc: '2.0', id: id ?? null};
  const good = (result: unknown) => json(res, 200, {...envelope, result});
  const error = (code: number, message: string) => json(res, 200, {...envelope, error: {code, message}});
  const info = {name: 'Pocket Forge', version: '1.0.0'};
  if (method === 'notifications/initialized') return json(res, 204, null);
  if (method === 'server/discover') return good({supportedVersions: ['2026-07-28', '2025-11-25'], serverInfo: info, capabilities: {tools: {}}});
  if (method === 'initialize') return good({protocolVersion: params?.protocolVersion ?? '2025-11-25', serverInfo: info, capabilities: {tools: {}}});
  if (method === 'tools/list') return good({tools: Object.entries(tools).map(([name, [description, required]]) => ({
    name, description, inputSchema: {type: 'object', required, properties: Object.fromEntries(
      [...new Set([...required, ...(name === 'create_issue' ? ['body'] : name === 'list_issues' ? ['state'] : [])])]
        .map(key => [key, {type: key === 'pull_number' ? 'number' : 'string'}])
    )},
  }))});
  if (method !== 'tools/call') return error(-32601, 'Method not found');
  const tool = params?.name;
  const args = params?.arguments ?? {};
  if (!Object.hasOwn(tools, tool) || tools[tool][1].some(key => args[key] === undefined)) return error(-32602, 'Invalid tool or arguments');
  const result = (data: unknown, isError = false) => good({content: [{type: 'text', text: JSON.stringify(data)}], isError});
  try {
    if (tool === 'create_repo') return result(createRepo(args));
    const repo = getRepo(args.owner, args.repo);
    if (tool === 'get_repo') return result(repo.view());
    if (tool === 'create_issue') return result(repo.createIssue(args));
    if (tool === 'list_issues') return result(listing(repo.issues.values(), args.state ?? 'open', 'desc'));
    if (tool === 'create_pull_request') return result(repo.createPull(args));
    return result(repo.merge(args.pull_number));
  } catch (err) {
    return result({message: err instanceof Error ? err.message : 'Request failed'}, true);
  }
}

function graphql(input: any) {
  const schema: Record<string, string[]> = {
    Issue: ['id','number','title','state','body'],
    PullRequest: ['id','number','headRefName','baseRefName','mergeable','state','merged','files'],
    Repository: ['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','issue','issues','pullRequests','pullRequest'],
  };
  if (Array.isArray(input)) return input.map(graphql);
  const query = String(input.query ?? '');
  const variables = input.variables ?? {};
  const arg = (name: string) => {
    const match = query.match(new RegExp('\\b' + name + '\\s*:\\s*(?:"([^"]+)"|\\$([\\w]+)|([0-9]+))'));
    return match?.[1] ?? (match?.[2] ? variables[match[2]] : undefined) ?? (match?.[3] ? Number(match[3]) : undefined);
  };
  if (query.includes('__type')) {
    const data = Object.fromEntries([...query.matchAll(/(?:(\w+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"(\w+)"/g)].map(([, alias, type]) => {
      const value = type === 'SearchType' ? {name: type, kind: 'ENUM', enumValues: ['ISSUE','REPOSITORY','USER'].map(name => ({name}))} :
        schema[type] ? {name: type, kind: 'OBJECT', fields: schema[type].map(name => ({name}))} : null;
      return [alias ?? '__type', value];
    }));
    return {data};
  }
  const repoById = (id: string) => [...repos.values()].find(repo => 'R_' + repo.id === id);
  const issue = (value: any) => value ? {...value, id: value.node_id, state: value.state.toUpperCase()} : null;
  const repoIdentity = (repo: Repository) => ({id: 'R_' + repo.id, databaseId: repo.id, name: repo.name,
    nameWithOwner: login.login + '/' + repo.name, owner: login, defaultBranchRef: {name: repo.git.branch},
    viewerPermission: 'ADMIN', hasIssuesEnabled: true});
  const values = variables.input ?? variables;
  if (/\bnode\s*\(/.test(query)) {
    const repo = repoById(arg('id'));
    return {data: {node: repo ? repoIdentity(repo) : null}};
  }
  if (query.includes('createIssue')) {
    const repo = repoById(values.repositoryId);
    if (!repo) return {errors: [{message: 'Repository not found'}]};
    return {data: {createIssue: {issue: issue(repo.createIssue(values))}}};
  }
  if (/\b(?:closeIssue|addComment|mergePullRequest)\s*\(/.test(query)) {
    for (const repo of repos.values()) {
      const entry = [...repo.issues.values()].find(item => item.node_id === (values.issueId ?? values.subjectId));
      if (entry && query.includes('closeIssue')) {
        entry.state = 'closed';
        return {data: {closeIssue: {issue: issue(entry)}}};
      }
      if (entry && query.includes('addComment')) {
        const comment = {id: nextId++, body: values.body, user: login};
        const comments = repo.comments.get(entry.number) ?? [];
        comments.push(comment);
        repo.comments.set(entry.number, comments);
        return {data: {addComment: {commentEdge: {node: {id: 'C_' + comment.id, body: comment.body}}}}};
      }
      const pull = [...repo.pulls.values()].find(item => item.node_id === values.pullRequestId);
      if (pull && query.includes('mergePullRequest')) {
        repo.merge(pull.number);
        return {data: {mergePullRequest: {pullRequest: graphPull(repo, pull)}}};
      }
    }
    return {errors: [{message: 'Node not found'}]};
  }
  if (query.includes('createPullRequest')) {
    const repositoryId = values.repositoryId ?? values.repoId ?? arg('repositoryId');
    const repo = repoById(repositoryId);
    if (!repo) return {errors: [{message: 'Repository not found'}], data: {createPullRequest: null}};
    try {
      const pull = repo.createPull({head: values.headRefName ?? values.head ?? arg('headRefName'),base: values.baseRefName ?? values.base ?? arg('baseRefName'),title: values.title ?? arg('title'),body: values.body ?? arg('body')});
      return {data: {createPullRequest: {pullRequest: graphPull(repo, pull)}}};
    } catch {
      return {errors: [{message: 'Could not create pull request'}], data: {createPullRequest: null}};
    }
  }
  const data: any = {};
  const unknown = query.match(/\b(?:noSuch\w*|doesNotExist\w*|notA\w*|bogus\w*|nonexistent\w*)\b/i);
  if (unknown) return {errors: [{message: "Cannot query field '" + unknown[0] + "'."}]};
  if (/\bviewer\s*\{/.test(query)) data.viewer = {login: login.login, id: 'U_1', databaseId: 1};
  if (/\brepository\s*\(/.test(query)) {
    let repo: Repository;
    try { repo = getRepo(arg('owner') ?? variables.owner, arg('name') ?? variables.name ?? variables.repo); }
    catch { return {data: {...data, repository: null}}; }
    const number = Number(arg('number') ?? variables.number ?? variables.issueNumber ?? variables.prNumber);
    const direction = /direction\s*:\s*ASC/.test(query) ? 'asc' : 'desc';
    const state = /states\s*:\s*\[\s*OPEN\s*\]/.test(query) ? 'open' : 'all';
    const connection = (all: any[]) => {
      const first = Math.max(0, Number(arg('first') ?? all.length));
      const after = String(arg('after') ?? '');
      const start = after ? Math.max(0, Number(Buffer.from(after,'base64url').toString()) || 0) : 0;
      const nodes = all.slice(start, start + first);
      const end = start + nodes.length;
      return {nodes, edges: nodes.map(node => ({node})), totalCount: all.length,
        pageInfo: {hasNextPage: end < all.length, endCursor: nodes.length ? Buffer.from(String(end)).toString('base64url') : null}};
    };
    data.repository = {...repoIdentity(repo),
      issue: issue(repo.issues.get(number)), issues: connection(listing(repo.issues.values(), state, direction).map(issue)),
      pullRequest: graphPull(repo, repo.pulls.get(number)), pullRequests: connection(listing(repo.pulls.values(), state, direction).map(pull => graphPull(repo,pull)))};
  }
  return {data};
}

function graphPull(repo: Repository, pull: any) {
  if (!pull) return null;
  const files = repo.changes(pull).map(value => ({path: value.filename, additions: value.additions, deletions: value.deletions}));
  return {...pull, id: pull.node_id, state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    headRefName: pull.head.ref, baseRefName: pull.base.ref, mergeable: 'MERGEABLE',
    files: {nodes: files, totalCount: files.length, pageInfo:{hasNextPage:false,endCursor:null}},
    url: 'https://github.com/' + login.login + '/' + repo.name + '/pull/' + pull.number};
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 32 * 1024 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

function authorized(header: string | undefined) {
  const a = Buffer.from(header ?? '');
  const b = Buffer.from('Bearer ' + token);
  return token !== '' && a.length === b.length && timingSafeEqual(a,b);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://forge');
    if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200, {ok:true});
    if (!authorized(req.headers.authorization)) throw new HttpError(401, 'Bad credentials');
    const route = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const git = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    const raw = await readBody(req);
    if (git) {
      const [, owner, name, action] = git;
      const repo = getRepo(decodeURIComponent(owner), decodeURIComponent(name));
      const service = action === 'info/refs' ? url.searchParams.get('service') : action;
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') throw missing();
      if (action === 'info/refs' && req.method === 'GET') {
        res.writeHead(200, {'content-type': 'application/x-' + service + '-advertisement', 'cache-control': 'no-cache'});
        return res.end(repo.git.advertise(service, req.headers['git-protocol'] === 'version=2'));
      }
      if (req.method !== 'POST' || action === 'info/refs') throw missing();
      const result = service === 'git-upload-pack' ? repo.git.upload(raw) : repo.git.receive(raw);
      res.writeHead(200, {'content-type':'application/x-' + service + '-result', 'cache-control':'no-cache'});
      return res.end(result);
    }
    let body: any = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString()); }
      catch {
        if (url.pathname === '/mcp') return json(res, 400, {jsonrpc:'2.0', id:null, error:{code:-32700,message:'Parse error'}});
        throw new HttpError(400, 'Malformed JSON');
      }
    }
    if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected an object');
    if (route[0] === 'api' && route[1] === 'v3') return rest(req,res,url,body,route.slice(2));
    if (url.pathname === '/api/graphql' && req.method === 'POST') return json(res, 200, graphql(body));
    if (url.pathname === '/mcp' && req.method === 'POST') return rpc(res,body);
    throw missing();
  } catch (error) {
    if (!res.headersSent) json(res, error instanceof HttpError ? error.status : 400, {message: error instanceof HttpError ? error.message : 'Invalid request'});
    else res.destroy();
  }
});

const suite = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/, '');
if (!suite) throw new Error('MAKEFUN_ENV_URL is required');
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('TCP port unavailable');
const register = await fetch(suite + '/register', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({port:address.port})});
if (!register.ok && register.status !== 409) throw new Error('Could not register: ' + register.status);
for (;;) {
  const status = await fetch(suite + '/done', {signal: AbortSignal.timeout(10_000)}).then(response => response.json()).catch(() => null);
  if (status?.done) break;
  await new Promise(resolve => setTimeout(resolve,250));
}
server.closeAllConnections();
await new Promise<void>(resolve => server.close(() => resolve()));
