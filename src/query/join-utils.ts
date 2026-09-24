import type { TableSchema } from '../schema/table-builder';
import { isForeignChainRef } from './query-utils';

/**
 * Literal value prefix used in navigation key parts.
 * When a key part starts with this prefix, it's a raw SQL literal (e.g. "5", "TRUE")
 * rather than a column name.
 */
export const LITERAL_PREFIX = '__LIT:';

/**
 * Format a join value as either a quoted column reference or a raw literal.
 * @param alias Table alias for column references
 * @param value Column name or "__LIT:value" for literals
 */
export function formatJoinValue(alias: string, value: string): string {
  if (value.startsWith(LITERAL_PREFIX)) {
    return value.substring(LITERAL_PREFIX.length);
  }
  return `"${alias}"."${value}"`;
}

/**
 * Check if a key part is a literal value (not a column reference).
 */
export function isLiteralKeyPart(value: string): boolean {
  return value.startsWith(LITERAL_PREFIX);
}

/**
 * A table as a FROM / JOIN item: `"<schema>"."<table>"` for a table outside the default schema,
 * else `"<table>"`. Column references may keep naming an unaliased table by its bare name —
 * PostgreSQL exposes `"s"."t"` as `"t"`.
 */
export function quoteTableReference(table: string, schema?: string): string {
  return schema ? `"${schema}"."${table}"` : `"${table}"`;
}

/**
 * Build the literal-only filter predicates from a navigation's composite FK/match
 * arrays. Used by strategies that DO NOT carry a source-table reference inside
 * the collection subquery (e.g. CTE, temptable). In those strategies the
 * parent-child column equality is materialised via parent_id grouping / JOIN,
 * so we only need to emit the navigation's CONSTANT predicates (e.g.
 * `target.is_current = true`) as WHERE filters on the target rows.
 *
 * A pair `(fk[i], match[i])` is considered a literal predicate when:
 *  - `match[i]` is a literal (`__LIT:value`) AND `fk[i]` is a column.
 *    Emits: `"<targetAlias>"."<fk>" = <literal>`.
 *  - both sides are literals. Emits: `<lhs-literal> = <rhs-literal>` (degenerate).
 *  - `fk[i]` is a literal AND `match[i]` is a column. Skipped — the source
 *    table isn't available inside the subquery; this shape isn't expressible
 *    here and shouldn't be configured for a hasMany navigation.
 *
 * Column-on-both-sides pairs (i.e. real composite-column FKs) are NOT emitted
 * by this helper — they are handled upstream via the strategy's existing
 * `parent_id`-grouping / JOIN mechanism.
 *
 * @param targetAlias Alias of the target/child table inside the subquery.
 * @param foreignKeys Composite FK columns on the target side (may include `__LIT:`).
 * @param matches     Match-key columns on the source side (may include `__LIT:`).
 */
export function buildLiteralOnlyPredicates(
  targetAlias: string,
  foreignKeys: string[] | undefined,
  matches: string[] | undefined,
): string[] {
  if (!foreignKeys || foreignKeys.length === 0 || !matches) {
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < foreignKeys.length; i++) {
    const fk = foreignKeys[i];
    const match = matches[i];
    const fkIsLit = isLiteralKeyPart(fk);
    const matchIsLit = match != null && isLiteralKeyPart(match);
    if (matchIsLit) {
      // target.fk = <literal>  (or  <literal> = <literal> when both sides literal)
      out.push(`${formatJoinValue(targetAlias, fk)} = ${formatJoinValue('', match)}`);
    } else if (fkIsLit) {
      // Source-side column without target column — not expressible inside a
      // strategy subquery that lacks a source-table reference. Skip silently.
      continue;
    }
    // column = column at i > 0: composite-column FK; the strategy's
    // parent_id/JOIN handles the i==0 column equality, and i > 0
    // composite-column equality isn't supported here. Skip.
  }
  return out;
}

/**
 * Build the parent-child correlation predicate for a collection projection,
 * supporting composite keys and literal-value (constant) FK predicates.
 *
 * Iterates `foreignKeys` × `matches` in lock-step. Each pair becomes a single
 * `<lhs> = <rhs>` clause via `formatJoinValue`, then all pairs are AND-ed.
 *
 * Examples
 * --------
 * Simple single column: `[fk] × [match]`
 *   `"<fkTable>"."<fk>" = "<sourceTable>"."<match>"`
 *
 * SCD2 constant FK (the bug case):
 *   foreignKeys: ['product_id', 'is_current']
 *   matches:     ['id', '__LIT:true']
 *
 *   pair 0 → `"<fkTable>"."product_id" = "<sourceTable>"."id"`
 *   pair 1 → `"<fkTable>"."is_current" = true`
 *   → final: `"<fkTable>"."product_id" = "<sourceTable>"."id" AND "<fkTable>"."is_current" = true`
 *
 * If `foreignKeys` is empty (legacy single-column form), the caller is expected
 * to fall back to the simple `fkAlias.fk = sourceAlias.match` form. This helper
 * itself returns an empty string in that case.
 *
 * @param fkAlias     Alias to qualify foreign-key columns on the child/target side.
 * @param sourceAlias Alias to qualify match columns on the parent/source side.
 * @param foreignKeys Composite FK columns on the child/target side; may include `__LIT:` markers.
 * @param matches     Composite match-key columns on the parent/source side; may include `__LIT:` markers.
 */
export function buildCollectionCorrelationWhere(
  fkAlias: string,
  sourceAlias: string,
  foreignKeys: string[],
  matches: string[],
): string {
  if (!foreignKeys || foreignKeys.length === 0) {
    return '';
  }
  const clauses: string[] = [];
  for (let i = 0; i < foreignKeys.length; i++) {
    const fk = foreignKeys[i];
    const match = matches[i] ?? 'id';
    clauses.push(`${formatJoinValue(fkAlias, fk)} = ${formatJoinValue(sourceAlias, match)}`);
  }
  return clauses.join(' AND ');
}

/**
 * The relation name of every navigation ref a {@link NavigationAliasPlan} currently renders under a
 * path alias. A plan re-aliases a ref by overwriting its `__tableAlias` for the duration of ONE build;
 * a build nested inside it (a correlated subquery rendered while the outer build runs) must still be
 * able to tell which relation the ref navigates.
 */
const renamedNavigationRefs = new WeakMap<object, string>();

/** UTF-8 length of an identifier — what PostgreSQL's 63-byte limit counts. */
const identifierBytes = (identifier: string): number => {
  let bytes = 0;

  for (const char of identifier) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }

  return bytes;
};

/**
 * One reference-navigation hop that a build's field refs traverse, identified by its RELATION PATH
 * from the build's anchor table (`edition.book`), not by its relation name — two paths ending in the
 * same name are two nodes. See {@link NavigationAliasPlan}.
 */
export interface NavigationPathNode {
  /** Relation names from the anchor, dot-joined: the node's identity. */
  readonly key: string;
  /** The relation this hop navigates. */
  readonly relationName: string;
  /** Hops from the anchor: 1 for a relation of the anchor table itself. */
  readonly depth: number;
  /** The hop this one hangs off; `undefined` when it hangs off the anchor. */
  readonly parent: NavigationPathNode | undefined;
  /** The `type: 'one'` relation config named `relationName` on the parent's (or the anchor's) table. */
  readonly relation: any;
  /** The joined table's schema: where the next hop's relation is looked up. */
  readonly targetSchema: TableSchema | undefined;
  /** First-appearance rank: the tie-break between two equally deep paths to one relation name. */
  readonly rank: number;
  /** The alias this hop renders under: its relation name if it owns that name, else a path alias. */
  alias: string;
  /** The aliases from the anchor side down to and including this hop's own. */
  chain: string[];
  /**
   * This hop's alias followed by its ancestors' aliases, anchor side first: the order in which the
   * join collectors have always recorded a ref's `__tableAlias` and `__navigationAliases`.
   */
  collectOrder: string[];
}

/**
 * The joins of ONE build's reference navigations, keyed by path.
 *
 * A reference navigation used to render under its relation NAME and was joined by that name, so two
 * paths ending in the same name (`ln.book` and `ln.edition.book`) collapsed into ONE join, and a
 * deep path (`ln.edition.book.category`) was anchored on the first joined table that had a relation
 * of that name — valid SQL that silently read another row. The plan records every path the build's
 * refs traverse, anchors each hop on its own parent, and gives each hop its alias:
 *
 * - the SHALLOWEST path to a relation name (then the one seen first) owns the plain name, so a query
 *   without a collision renders exactly the SQL it rendered before, and a raw `sql` fragment naming
 *   `"book"` keeps resolving to that path;
 * - every other path to the same name renders as `<parentAlias>__<relation>`
 *   (`edition__book`, `edition__book__category`);
 * - a hop named like the anchor table itself never owns its name either: under that name it would
 *   read the anchor's own row.
 *
 * Field refs are minted per mock row while the selection is built, before any collision is known,
 * so {@link apply} re-aliases the refs of the build in place (their `__tableAlias`) and hands back
 * the restore — the refs of conditions and `sql` fragments render their own alias, so this is the
 * one way to reach them. A build applies its plan, renders synchronously and restores in `finally`.
 *
 * A plan that changes nothing (every path one hop deep, no hop named like the anchor) is not built
 * at all ({@link seal} returns `undefined`): by-name resolution is exact for such queries, and the
 * builders keep their original code path for them.
 */
export class NavigationAliasPlan {
  /**
   * Refs of ours and paths (relation names), in order of first appearance. They are resolved into
   * nodes only once the plan turns out able to change the SQL: most builds navigate one hop deep at
   * most, and pay for this list and nothing else.
   */
  private readonly recorded: Array<object | readonly string[]> = [];
  private changesSql = false;
  private deepest = 0;
  // Built by seal(), for a plan that can change the SQL
  private nodesByKey!: Map<string, NavigationPathNode>;
  private nodesByAlias!: Map<string, NavigationPathNode>;
  private nodesByRef!: Map<object, NavigationPathNode>;
  private owners!: Map<string, NavigationPathNode>;

  /**
   * @param anchorSchema The table the paths start from: the query's root, or a collection's target.
   * @param anchorAlias  The alias that table renders under in the build's scope.
   * @param registry     The schema registry, which gives each hop's target its relations.
   * @param ownChainId   The build's chain id: refs of another chain are correlations, never ours.
   * @param reservedAliases Aliases other joins already render under in the build's scope — for a
   *   collection, the hops of the navigation path it hangs off. A hop of ours named like one never
   *   renders under that name: in one FROM it would duplicate the alias, and in a subquery that
   *   correlates to the enclosing scope's join of that name it would shadow the correlation.
   */
  constructor(
    private readonly anchorSchema: TableSchema,
    readonly anchorAlias: string,
    private readonly registry: Map<string, TableSchema> | undefined,
    private readonly ownChainId: number | undefined,
    private readonly reservedAliases: ReadonlySet<string> = new Set(),
  ) {}

  /** Records the path `ref` navigates, when it is a reference navigation of this build's own. */
  addRef(ref: unknown): void {
    if (ref === null || typeof ref !== 'object' || !('__dbColumnName' in ref)) {
      return;
    }

    const fieldRef = ref as any;
    const navigationAliases = fieldRef.__navigationAliases;

    if (!Array.isArray(navigationAliases) || fieldRef.__joinPath !== undefined || isForeignChainRef(fieldRef, this.ownChainId)) {
      return;
    }

    this.recorded.push(fieldRef);

    const relationName = renamedNavigationRefs.get(fieldRef) ?? fieldRef.__tableAlias;

    if (navigationAliases.length > 0 || relationName === this.anchorAlias || this.reservedAliases.has(relationName)) {
      this.changesSql = true;
    }
  }

  /** Records a path given as relation names from the anchor (the path a nested collection hangs off). */
  addPath(names: readonly string[]): void {
    if (names.length === 0) {
      return;
    }

    this.recorded.push(names);

    if (names.length > 1 || names[0] === this.anchorAlias || this.reservedAliases.has(names[0])) {
      this.changesSql = true;
    }
  }

  /**
   * Assigns every hop its alias. Returns `undefined` when the plan could not change the SQL (see the
   * class comment), else the plan itself.
   *
   * Throws when a path alias would exceed PostgreSQL's 63-byte identifier limit (a truncated alias can
   * collide with another one) or would equal an alias another hop already renders under.
   */
  seal(): NavigationAliasPlan | undefined {
    if (!this.changesSql) {
      return undefined;
    }

    this.nodesByKey = new Map();
    this.nodesByAlias = new Map();
    this.nodesByRef = new Map();
    this.owners = new Map();

    for (const entry of this.recorded) {
      if (Array.isArray(entry)) {
        this.nodeForNames(entry);
        continue;
      }

      const names = this.pathOf(entry);
      const node = names === undefined ? undefined : this.nodeForNames(names);

      if (node !== undefined) {
        this.nodesByRef.set(entry, node);
      }
    }

    const nodes = [...this.nodesByKey.values()].sort((a, b) => a.depth - b.depth || a.rank - b.rank);
    let renamed = false;

    for (const node of nodes) {
      if (!this.owners.has(node.relationName) && node.relationName !== this.anchorAlias && !this.reservedAliases.has(node.relationName)) {
        this.owners.set(node.relationName, node);
      }
    }

    // Depth order: a parent's alias is final before its children's path aliases are derived from it
    for (const node of nodes) {
      if (this.owners.get(node.relationName) !== node) {
        node.alias = this.pathAlias(node);
        renamed = true;
      }

      const taken = this.nodesByAlias.get(node.alias);

      if (taken !== undefined) {
        throw new Error(
          `The navigation path "${node.key}" from "${this.anchorAlias}" would render under the alias "${node.alias}", `
          + `which the path "${taken.key}" already renders under. Read one of the two paths in a separate query, `
          + 'or rename one of the relations.'
        );
      }

      this.nodesByAlias.set(node.alias, node);
      node.chain = node.parent === undefined ? [node.alias] : [...node.parent.chain, node.alias];
      node.collectOrder = node.parent === undefined ? [node.alias] : [node.alias, ...node.parent.chain];
    }

    return this.deepest < 2 && !renamed ? undefined : this;
  }

  /** The node of the path `ref` navigates, or `undefined` for a ref that is not a navigation of ours. */
  nodeOf(ref: unknown): NavigationPathNode | undefined {
    if (ref === null || typeof ref !== 'object') {
      return undefined;
    }

    const recorded = this.nodesByRef.get(ref);

    if (recorded !== undefined) {
      return recorded;
    }

    const names = this.pathOf(ref);

    return names === undefined ? undefined : this.nodesByKey.get(names.join('.'));
  }

  /** The node rendering under `alias`. */
  nodeForAlias(alias: string): NavigationPathNode | undefined {
    return this.nodesByAlias.get(alias);
  }

  /** The node of a path given as relation names from the anchor. */
  nodeForPath(names: readonly string[]): NavigationPathNode | undefined {
    return this.nodesByKey.get(names.join('.'));
  }

  /** The alias the table a node hangs off renders under. */
  parentAliasOf(node: NavigationPathNode): string {
    return node.parent === undefined ? this.anchorAlias : node.parent.alias;
  }

  /** A node's join, in the shape every resolver builds: its own alias, on its parent's alias. */
  joinOf(node: NavigationPathNode): {
    alias: string;
    targetTable: string;
    targetSchema?: string;
    foreignKeys: string[];
    matches: string[];
    isMandatory: boolean;
    sourceAlias: string;
  } {
    const relation = node.relation;

    return {
      alias: node.alias,
      targetTable: relation.targetTable,
      targetSchema: node.targetSchema?.schema,
      foreignKeys: relation.foreignKeys || [relation.foreignKey || ''],
      matches: relation.matches || ['id'],
      isMandatory: relation.isMandatory ?? false,
      sourceAlias: this.parentAliasOf(node),
    };
  }

  /**
   * The first hop that lost its plain name to another path, with the path that kept it (`undefined`
   * when the hop is named like the anchor table itself).
   */
  firstRenamed(): { node: NavigationPathNode; owner: NavigationPathNode | undefined } | undefined {
    for (const node of this.nodesByKey.values()) {
      if (node.alias !== node.relationName) {
        return { node, owner: this.owners.get(node.relationName) };
      }
    }

    return undefined;
  }

  /**
   * Re-aliases the refs recorded through {@link addRef} to their path's alias and returns the
   * function that restores them. Only refs whose path lost its plain name change at all.
   */
  apply(): () => void {
    const renamed: Array<{ ref: any; previous: string; recorded: boolean }> = [];

    for (const [ref, node] of this.nodesByRef) {
      const fieldRef = ref as any;

      if (fieldRef.__tableAlias !== node.alias) {
        const recorded = !renamedNavigationRefs.has(fieldRef);

        if (recorded) {
          renamedNavigationRefs.set(fieldRef, fieldRef.__tableAlias);
        }

        renamed.push({ ref: fieldRef, previous: fieldRef.__tableAlias, recorded });
        fieldRef.__tableAlias = node.alias;
      }
    }

    return () => {
      for (let i = renamed.length - 1; i >= 0; i--) {
        const { ref, previous, recorded } = renamed[i];
        ref.__tableAlias = previous;

        if (recorded) {
          renamedNavigationRefs.delete(ref);
        }
      }
    };
  }

  /**
   * The relation path of a reference-navigation ref of this build's own: its `__navigationAliases`
   * (the hops before it, which carry the relation names) plus its own relation name. A column of a
   * manually joined table's navigation (`__joinPath`) names its joins itself and is left out.
   */
  private pathOf(ref: unknown): string[] | undefined {
    if (ref === null || typeof ref !== 'object' || !('__dbColumnName' in ref)) {
      return undefined;
    }

    const fieldRef = ref as any;

    if (fieldRef.__joinPath !== undefined || !Array.isArray(fieldRef.__navigationAliases) || isForeignChainRef(fieldRef, this.ownChainId)) {
      return undefined;
    }

    const relationName = renamedNavigationRefs.get(fieldRef) ?? fieldRef.__tableAlias;

    if (typeof relationName !== 'string' || relationName === '') {
      return undefined;
    }

    return fieldRef.__navigationAliases.length === 0 ? [relationName] : [...fieldRef.__navigationAliases, relationName];
  }

  /** The node of `names`, creating it and its ancestors; `undefined` when a hop is not a reference relation. */
  private nodeForNames(names: readonly string[]): NavigationPathNode | undefined {
    let parent: NavigationPathNode | undefined;
    let schema: TableSchema | undefined = this.anchorSchema;
    let key = '';

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      key = i === 0 ? name : `${key}.${name}`;
      let node = this.nodesByKey.get(key);

      if (node === undefined) {
        const relation: any = schema?.relations?.[name];

        if (!relation || relation.type !== 'one') {
          return undefined;
        }

        node = {
          key,
          relationName: name,
          depth: i + 1,
          parent,
          relation,
          targetSchema: this.registry?.get(relation.targetTable) ?? relation.targetTableBuilder?.build(),
          rank: this.nodesByKey.size,
          alias: name,
          chain: [],
          collectOrder: [],
        };
        this.nodesByKey.set(key, node);

        if (node.depth > this.deepest) {
          this.deepest = node.depth;
        }
      }

      parent = node;
      schema = node.targetSchema;
    }

    return parent;
  }

  /** `<parentAlias>__<relation>`, refused past PostgreSQL's 63-byte identifier limit. */
  private pathAlias(node: NavigationPathNode): string {
    const alias = `${this.parentAliasOf(node)}__${node.relationName}`;

    if (identifierBytes(alias) > 63) {
      const owner = this.owners.get(node.relationName);

      throw new Error(
        `The navigation path "${node.key}" from "${this.anchorAlias}" needs a join of its own`
        + (owner !== undefined ? ` because the path "${owner.key}" renders under "${node.relationName}"` : '')
        + `, but its alias "${alias}" is longer than PostgreSQL's 63-byte identifier limit. `
        + 'Read one of the paths in a separate query, or give the relation a shorter name.'
      );
    }

    return alias;
  }
}
