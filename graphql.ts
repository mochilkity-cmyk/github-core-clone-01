// graphql.ts — a small GraphQL v4 surface: a parser for the documents gh and
// github-mcp-server send, plus an executor over the forge store. No validation
// library, no schema engine: the field table below is the schema. Standard library only.
import {
  Forge,
  VIEWER_LOGIN,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, ValueNode>;
  selections: Selection[];
}
interface InlineFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}
type Selection = FieldSelection | InlineFragment;

interface OperationDef {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Record<string, ValueNode>;
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: OperationDef[];
  fragments: Map<string, FragmentDef>;
}

type Token =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: string }
  | { type: 'punct'; value: string }
  | { type: 'spread'; value: '...' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ type: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ type: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ type: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i + 1;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push({ type: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:$!=@|'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }
  private expectName(): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.type === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefaults: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = token.value as 'query' | 'mutation';
        this.next();
        let name: string | null = null;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.type === 'name') name = this.next().value as string;
        const variableDefaults: Record<string, ValueNode> = {};
        const paren = this.peek();
        if (paren !== undefined && paren.type === 'punct' && paren.value === '(') {
          this.next();
          while (true) {
            const dollar = this.next();
            if (dollar.type === 'punct' && dollar.value === ')') break;
            if (dollar.type !== 'punct' || dollar.value !== '$') throw new Error('expected $ in variable definition');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            const eq = this.peek();
            if (eq !== undefined && eq.type === 'punct' && eq.value === '=') {
              this.next();
              variableDefaults[varName] = this.parseValue();
            }
            const after = this.peek();
            if (after !== undefined && after.type === 'punct' && after.value === ')') {
              this.next();
              break;
            }
          }
        }
        operations.push({ operation, name, variableDefaults, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.type === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.next();
        if (on.type !== 'name' || on.value !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  /** Skip a type annotation (e.g. String!, [IssueState!], CreateIssueInput). */
  private parseType(): void {
    const token = this.peek();
    if (token !== undefined && token.type === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    const bang = this.peek();
    if (bang !== undefined && bang.type === 'punct' && bang.value === '!') this.next();
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.type === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): Selection {
    const token = this.peek()!;
    if (token.type === 'spread') {
      this.next();
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.type === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (nextToken !== undefined && nextToken.type === 'name') {
        const fragmentName = this.next().value as string;
        return { kind: 'fragment', typeCondition: `__fragment:${fragmentName}`, selections: [] };
      }
      return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const nameOrAlias = this.expectName();
    let name = nameOrAlias;
    let alias = nameOrAlias;
    const colon = this.peek();
    if (colon !== undefined && colon.type === 'punct' && colon.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    const paren = this.peek();
    if (paren !== undefined && paren.type === 'punct' && paren.value === '(') {
      this.next();
      while (true) {
        const close = this.peek();
        if (close !== undefined && close.type === 'punct' && close.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    const brace = this.peek();
    const selections = brace !== undefined && brace.type === 'punct' && brace.value === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.type === 'string') return { kind: 'string', value: token.value };
    if (token.type === 'number') {
      return token.value.includes('.') || token.value.includes('e') || token.value.includes('E')
        ? { kind: 'float', value: Number(token.value) }
        : { kind: 'int', value: Number(token.value) };
    }
    if (token.type === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.type === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (true) {
        const close = this.peek();
        if (close !== undefined && close.type === 'punct' && close.value === ']') {
          this.next();
          return { kind: 'list', items };
        }
        items.push(this.parseValue());
      }
    }
    if (token.type === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (true) {
        const close = this.peek();
        if (close !== undefined && close.type === 'punct' && close.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
    }
    if (token.type === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------- the field table

/** The fields each type exposes (the introspection surface and the unknown-field check). */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'isPrivate',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'comments', 'labels', 'url'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'createdAt', 'updatedAt', 'url',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name'],
  IssueComment: ['id', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
});

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'CODE', 'MARKETPLACE_LISTING', 'PROJECT'],
});

// -------------------------------------------------------------------------------- values

/** A resolved object value: its GraphQL type plus the data its fields read. */
interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function userObject(login: string): GqlObject {
  return { __typename: 'User', login };
}

function repoObject(forge: Forge, repo: Repo): GqlObject {
  return { __typename: 'Repository', __repo: repo, __forge: forge };
}

function issueObject(forge: Forge, repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', __repo: repo, __forge: forge, __issue: issue };
}

function pullObject(forge: Forge, repo: Repo, pull: PullRequest): GqlObject {
  return { __typename: 'PullRequest', __repo: repo, __forge: forge, __pull: pull };
}

function commentObject(forge: Forge, repo: Repo, issue: Issue, comment: { id: number; body: string }): GqlObject {
  return { __typename: 'IssueComment', __repo: repo, __forge: forge, __issue: issue, __comment: comment };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function pageInfoFor(numbers: number[], hasNext: boolean): GqlObject {
  return {
    __typename: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: false,
    startCursor: numbers.length > 0 ? cursorFor(numbers[0]!) : null,
    endCursor: numbers.length > 0 ? cursorFor(numbers[numbers.length - 1]!) : null,
  };
}

// -------------------------------------------------------------------------------- executor

interface ExecError {
  message: string;
}

class GqlValidationError extends Error {}

export function executeGraphQL(
  forge: Forge,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors?: Array<{ message: string }> } {
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL parse error' }] };
  }
  const operation =
    document.operations.find((candidate) => candidate.name === operationName) ??
    document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of Object.entries(operation.variableDefaults)) {
    if (vars[name] === undefined) vars[name] = resolveValue(defaultValue, vars);
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType, __forge: forge };
  try {
    const data = executeSelections(forge, document, rootType, root, operation.selections, vars, []);
    return { data };
  } catch (error) {
    if (error instanceof GqlValidationError) return { data: null, errors: [{ message: error.message }] };
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL execution error' }] };
  }
}

function executeSelections(
  forge: Forge,
  document: Document,
  typeName: string,
  object: GqlObject,
  selections: Selection[],
  variables: Record<string, unknown>,
  errors: ExecError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      let fragmentSelections = selection.selections;
      let condition = selection.typeCondition;
      if (condition !== null && condition.startsWith('__fragment:')) {
        const fragment = document.fragments.get(condition.slice('__fragment:'.length));
        if (fragment === undefined) continue;
        condition = fragment.typeCondition;
        fragmentSelections = fragment.selections;
      }
      if (condition !== null && condition !== object.__typename) continue;
      const nested = executeSelections(forge, document, object.__typename, object, fragmentSelections, variables, errors);
      Object.assign(out, nested);
      continue;
    }
    const fieldName = selection.name;
    if (fieldName === '__typename') {
      out[selection.alias] = object.__typename;
      continue;
    }
    const known = TYPE_FIELDS[typeName] ?? [];
    if (!known.includes(fieldName)) {
      throw new GqlValidationError(`Cannot query field "${fieldName}" on type "${typeName}".`);
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(selection.args)) args[key] = resolveValue(value, variables);
    const value = resolveField(forge, document, typeName, object, fieldName, args, variables, errors);
    out[selection.alias] = completeValue(forge, document, typeName, fieldName, value, selection.selections, variables, errors);
  }
  return out;
}

function completeValue(
  forge: Forge,
  document: Document,
  parentType: string,
  fieldName: string,
  value: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
  errors: ExecError[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(forge, document, parentType, fieldName, item, selections, variables, errors));
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    const object = value as GqlObject;
    // An object field with no sub-selections serializes as just its type name;
    // the internal __forge/__repo keys must never reach JSON.
    if (selections.length === 0) return { __typename: object.__typename };
    return executeSelections(forge, document, object.__typename, object, selections, variables, errors);
  }
  return value;
}

function resolveField(
  forge: Forge,
  document: Document,
  typeName: string,
  object: GqlObject,
  fieldName: string,
  args: Record<string, unknown>,
  variables: Record<string, unknown>,
  errors: ExecError[],
): unknown {
  void document;
  void variables;
  void errors;
  switch (typeName) {
    case 'Query': {
      if (fieldName === 'viewer') return userObject(VIEWER_LOGIN);
      if (fieldName === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = forge.getRepo(owner, name);
        return repo === undefined ? null : repoObject(forge, repo);
      }
      if (fieldName === 'node') {
        const decoded = forge.decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        const repo = forge.getRepo(decoded.owner, decoded.name);
        if (repo === undefined) return null;
        if (decoded.kind === 'Repository') return repoObject(forge, repo);
        if (decoded.kind === 'Issue' && decoded.number !== null) {
          const issue = repo.issues.get(decoded.number);
          return issue === undefined ? null : issueObject(forge, repo, issue);
        }
        if (decoded.kind === 'PullRequest' && decoded.number !== null) {
          const pull = repo.pulls.get(decoded.number);
          return pull === undefined ? null : pullObject(forge, repo, pull);
        }
        if (decoded.kind === 'IssueComment' && decoded.number !== null && decoded.commentId !== null) {
          const issue = repo.issues.get(decoded.number);
          const comment = issue?.comments.find((candidate) => candidate.id === decoded.commentId);
          return issue !== undefined && comment !== undefined ? commentObject(forge, repo, issue, comment) : null;
        }
        return null;
      }
      if (fieldName === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] !== undefined || ENUM_VALUES[name] !== undefined) {
          return { __typename: '__Type', __typeName: name };
        }
        return null;
      }
      return null;
    }
    case 'Mutation': {
      if (fieldName === 'createIssue') return mutateCreateIssue(forge, args);
      if (fieldName === 'closeIssue') return mutateCloseIssue(forge, args);
      if (fieldName === 'createPullRequest') return mutateCreatePullRequest(forge, args);
      if (fieldName === 'mergePullRequest') return mutateMergePullRequest(forge, args);
      if (fieldName === 'addComment') return mutateAddComment(forge, args);
      return null;
    }
    case 'User': {
      if (fieldName === 'login') return object.login;
      if (fieldName === 'name') return 'ada iversen';
      return null;
    }
    case 'Repository': {
      const repo = object.__repo as Repo;
      switch (fieldName) {
        case 'id':
          return forge.repoGlobalId(repo);
        case 'databaseId':
          return repo.databaseId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return userObject(repo.owner);
        case 'defaultBranchRef': {
          const tip = forge.defaultTip(repo);
          return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'isPrivate':
          return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueObject(forge, repo, issue);
        }
        case 'issues':
          return issuesConnection(forge, repo, args);
        case 'pullRequests':
          return pullsConnection(forge, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullObject(forge, repo, pull);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = object.__issue as Issue;
      const repo = object.__repo as Repo;
      switch (fieldName) {
        case 'id':
          return forge.issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return userObject(issue.user);
        case 'createdAt':
          return forge.isoOfSeq(issue.createdSeq);
        case 'updatedAt':
          return forge.isoOfSeq(issue.updatedSeq);
        case 'comments':
          return issue.comments.map((comment) => commentObject(forge, repo, issue, comment));
        case 'labels':
          return issue.labels.map((label) => ({ __typename: 'Label', name: label }));
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        default:
          return null;
      }
    }
    case 'IssueConnection': {
      if (fieldName === 'nodes') return object.__nodes as unknown[];
      if (fieldName === 'pageInfo') return object.__pageInfo as GqlObject;
      if (fieldName === 'totalCount') return (object.__nodes as unknown[]).length;
      return null;
    }
    case 'PullRequestConnection': {
      if (fieldName === 'nodes') return object.__nodes as unknown[];
      if (fieldName === 'pageInfo') return object.__pageInfo as GqlObject;
      if (fieldName === 'totalCount') return (object.__nodes as unknown[]).length;
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (fieldName === 'nodes') return object.__nodes as unknown[];
      if (fieldName === 'pageInfo') return object.__pageInfo as GqlObject;
      if (fieldName === 'totalCount') return (object.__nodes as unknown[]).length;
      return null;
    }
    case 'PageInfo': {
      return object[fieldName] ?? null;
    }
    case 'PullRequest': {
      const pull = object.__pull as PullRequest;
      const repo = object.__repo as Repo;
      switch (fieldName) {
        case 'id':
          return forge.pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          return forge.mergeConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'author':
          return userObject(pull.user);
        case 'createdAt':
          return forge.isoOfSeq(pull.createdSeq);
        case 'updatedAt':
          return forge.isoOfSeq(pull.updatedSeq);
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'files': {
          const files = forge.pullFiles(repo, pull);
          const first = typeof args.first === 'number' ? args.first : files.length;
          const nodes = files.slice(0, first).map((file) => ({
            __typename: 'PullRequestChangedFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          }));
          return {
            __typename: 'PullRequestChangedFileConnection',
            __nodes: nodes,
            __pageInfo: pageInfoFor(files.slice(0, first).map((_, index) => index), files.length > first),
          };
        }
        default:
          return null;
      }
    }
    case 'PullRequestChangedFile': {
      return object[fieldName] ?? null;
    }
    case 'Ref': {
      return object[fieldName] ?? null;
    }
    case 'IssueComment': {
      const comment = object.__comment as { id: number; body: string };
      if (fieldName === 'id') {
        const repo = object.__repo as Repo;
        const issue = object.__issue as Issue;
        return forge.commentGlobalId(repo, issue, comment as never);
      }
      if (fieldName === 'body') return comment.body;
      return null;
    }
    case 'IssueCommentEdge': {
      if (fieldName === 'node') return object.__node as GqlObject;
      if (fieldName === 'cursor') return object.__cursor as string;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (fieldName === 'issue') return object.__issue as GqlObject;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (fieldName === 'pullRequest') return object.__pullRequest as GqlObject;
      return null;
    }
    case 'AddCommentPayload': {
      if (fieldName === 'commentEdge') return object.__commentEdge as GqlObject;
      return null;
    }
    case '__Type': {
      const name = object.__typeName as string;
      if (fieldName === 'name') return name;
      if (fieldName === 'kind') return ENUM_VALUES[name] !== undefined ? 'ENUM' : 'OBJECT';
      if (fieldName === 'fields') {
        return (TYPE_FIELDS[name] ?? []).map((field) => ({ __typename: '__Field', name: field }));
      }
      if (fieldName === 'enumValues') {
        return (ENUM_VALUES[name] ?? []).map((value) => ({ __typename: '__EnumValue', name: value }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (fieldName === 'name') return object.name;
      return null;
    }
    default:
      return null;
  }
}

function issuesConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
  issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  return {
    __typename: 'IssueConnection',
    __nodes: page.map((issue) => issueObject(forge, repo, issue)),
    __pageInfo: pageInfoFor(page.map((issue) => issue.number), issues.length > first),
  };
}

function pullsConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlObject {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    __nodes: page.map((pull) => pullObject(forge, repo, pull)),
    __pageInfo: pageInfoFor(page.map((pull) => pull.number), pulls.length > first),
  };
}

// -------------------------------------------------------------------------------- mutations

function repoFromGlobalId(forge: Forge, globalId: string): Repo | null {
  const decoded = forge.decodeGlobalId(globalId);
  if (decoded === null) return null;
  return forge.getRepo(decoded.owner, decoded.name) ?? null;
}

function mutateCreateIssue(forge: Forge, args: Record<string, unknown>): GqlObject | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoFromGlobalId(forge, String(input.repositoryId ?? ''));
  if (repo === null) return null;
  const labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === 'string') : [];
  const created = forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), labels);
  if (created.error !== undefined || created.issue === undefined) return null;
  return { __typename: 'CreateIssuePayload', __issue: issueObject(forge, repo, created.issue) };
}

function mutateCloseIssue(forge: Forge, args: Record<string, unknown>): GqlObject | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = forge.decodeGlobalId(String(input.issueId ?? ''));
  if (decoded === null || decoded.kind !== 'Issue' || decoded.number === null) return null;
  const repo = forge.getRepo(decoded.owner, decoded.name);
  const issue = repo?.issues.get(decoded.number);
  if (repo === undefined || issue === undefined) return null;
  issue.state = 'closed';
  issue.updatedSeq = forge.nextTs();
  return { __typename: 'CloseIssuePayload', __issue: issueObject(forge, repo, issue) };
}

function mutateCreatePullRequest(forge: Forge, args: Record<string, unknown>): GqlObject | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const repo = repoFromGlobalId(forge, String(input.repositoryId ?? ''));
  if (repo === null) return null;
  const created = forge.createPull(
    repo,
    String(input.headRefName ?? ''),
    String(input.baseRefName ?? ''),
    String(input.title ?? ''),
    String(input.body ?? ''),
  );
  if (created.error !== undefined || created.pull === undefined) return null;
  return { __typename: 'CreatePullRequestPayload', __pullRequest: pullObject(forge, repo, created.pull) };
}

function mutateMergePullRequest(forge: Forge, args: Record<string, unknown>): GqlObject | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = forge.decodeGlobalId(String(input.pullRequestId ?? ''));
  if (decoded === null || decoded.kind !== 'PullRequest' || decoded.number === null) return null;
  const repo = forge.getRepo(decoded.owner, decoded.name);
  const pull = repo?.pulls.get(decoded.number);
  if (repo === undefined || pull === undefined) return null;
  const merged = forge.squashMerge(repo, pull);
  if ('error' in merged) return null;
  return { __typename: 'MergePullRequestPayload', __pullRequest: pullObject(forge, repo, pull) };
}

function mutateAddComment(forge: Forge, args: Record<string, unknown>): GqlObject | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const decoded = forge.decodeGlobalId(String(input.subjectId ?? ''));
  if (decoded === null || decoded.kind !== 'Issue' || decoded.number === null) return null;
  const repo = forge.getRepo(decoded.owner, decoded.name);
  const issue = repo?.issues.get(decoded.number);
  if (repo === undefined || issue === undefined) return null;
  const created = forge.createComment(repo, decoded.number, String(input.body ?? ''));
  if (created.error !== undefined || created.comment === undefined) return null;
  const node = commentObject(forge, repo, issue, created.comment);
  return {
    __typename: 'AddCommentPayload',
    __commentEdge: {
      __typename: 'IssueCommentEdge',
      __node: node,
      __cursor: cursorFor(created.comment.id),
    },
  };
}
