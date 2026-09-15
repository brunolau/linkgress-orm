import * as A from '../ast';
import { Catalog, NS_PUBLIC, OperatorDef, ProcDef, TypeOid } from '../catalog/catalog';
import { PgError, SqlState } from '../errors';
import type { Session } from '../session';

interface ExtensionSpec {
  version: string;
  install(session: Session, cat: Catalog, nspOid: number, extOid: number): void;
}

function addProc(session: Session, cat: Catalog, nspOid: number, extOid: number, p: Partial<ProcDef> & Pick<ProcDef, 'name' | 'argtypes' | 'rettype' | 'src'>): ProcDef {
  const proc: ProcDef = {
    oid: session.db.oids.allocate(),
    nspOid,
    kind: 'f',
    strict: true,
    retset: false,
    volatile: 'i',
    nargdefaults: 0,
    variadic: 0,
    lang: 'c',
    isBuiltin: true,
    ...p,
  };
  (proc as ProcDef & { extension: number }).extension = extOid;
  cat.putProc(proc);
  return proc;
}

function addOperator(session: Session, cat: Catalog, nspOid: number, extOid: number, name: string, left: number, right: number, result: number, proc: ProcDef): void {
  const op: OperatorDef = { oid: session.db.oids.allocate(), name, nspOid, kind: 'b', left, right, result, commutator: 0, negator: 0, codeSrc: proc.src, codeOid: proc.oid };
  (op as OperatorDef & { extension: number }).extension = extOid;
  cat.operators.set(op.oid, op);
}

const EXTENSIONS: Record<string, ExtensionSpec> = {
  pg_trgm: {
    version: '1.6',
    install(session, cat, nspOid, extOid) {
      const sim = addProc(session, cat, nspOid, extOid, { name: 'similarity', argtypes: [TypeOid.text, TypeOid.text], rettype: TypeOid.float4, src: 'similarity' });
      addProc(session, cat, nspOid, extOid, { name: 'word_similarity', argtypes: [TypeOid.text, TypeOid.text], rettype: TypeOid.float4, src: 'word_similarity' });
      addProc(session, cat, nspOid, extOid, { name: 'strict_word_similarity', argtypes: [TypeOid.text, TypeOid.text], rettype: TypeOid.float4, src: 'strict_word_similarity' });
      addProc(session, cat, nspOid, extOid, { name: 'show_trgm', argtypes: [TypeOid.text], rettype: TypeOid._text, src: 'show_trgm' });
      addProc(session, cat, nspOid, extOid, { name: 'show_limit', argtypes: [], rettype: TypeOid.float4, src: 'show_limit', volatile: 's' });
      addProc(session, cat, nspOid, extOid, { name: 'set_limit', argtypes: [TypeOid.float4], rettype: TypeOid.float4, src: 'set_limit', volatile: 'v' });
      const simOp = addProc(session, cat, nspOid, extOid, { name: 'similarity_op', argtypes: [TypeOid.text, TypeOid.text], rettype: TypeOid.bool, src: 'similarity_op', volatile: 's' });
      const dist = addProc(session, cat, nspOid, extOid, { name: 'similarity_dist', argtypes: [TypeOid.text, TypeOid.text], rettype: TypeOid.float4, src: 'similarity_dist' });
      const wsOp = addProc(session, cat, nspOid, extOid, { name: 'word_similarity_op', argtypes: [TypeOid.text, TypeOid.text], rettype: TypeOid.bool, src: 'word_similarity_op', volatile: 's' });
      const wsCOp = addProc(session, cat, nspOid, extOid, { name: 'word_similarity_commutator_op', argtypes: [TypeOid.text, TypeOid.text], rettype: TypeOid.bool, src: 'word_similarity_commutator_op', volatile: 's' });
      addOperator(session, cat, nspOid, extOid, '%', TypeOid.text, TypeOid.text, TypeOid.bool, simOp);
      addOperator(session, cat, nspOid, extOid, '<->', TypeOid.text, TypeOid.text, TypeOid.float4, dist);
      addOperator(session, cat, nspOid, extOid, '<%', TypeOid.text, TypeOid.text, TypeOid.bool, wsOp);
      addOperator(session, cat, nspOid, extOid, '%>', TypeOid.text, TypeOid.text, TypeOid.bool, wsCOp);
      void sim;
      const ocGin = session.db.oids.allocate();
      const ocGist = session.db.oids.allocate();
      cat.comments.set('opclass:gin:gin_trgm_ops', String(ocGin));
      cat.comments.set('opclass:gist:gist_trgm_ops', String(ocGist));
      cat.comments.set(`opclassdef:${ocGin}`, JSON.stringify({ name: 'gin_trgm_ops', am: 'gin', nspOid }));
      cat.comments.set(`opclassdef:${ocGist}`, JSON.stringify({ name: 'gist_trgm_ops', am: 'gist', nspOid }));
    },
  },
  unaccent: {
    version: '1.1',
    install(session, cat, nspOid, extOid) {
      addProc(session, cat, nspOid, extOid, { name: 'unaccent', argtypes: [TypeOid.text], rettype: TypeOid.text, src: 'unaccent_dict', volatile: 's' });
      addProc(session, cat, nspOid, extOid, { name: 'unaccent', argtypes: [3769, TypeOid.text], rettype: TypeOid.text, src: 'unaccent_dict', volatile: 's' });
    },
  },
  'uuid-ossp': {
    version: '1.1',
    install(session, cat, nspOid, extOid) {
      addProc(session, cat, nspOid, extOid, { name: 'uuid_generate_v4', argtypes: [], rettype: TypeOid.uuid, src: 'gen_random_uuid', volatile: 'v' });
      addProc(session, cat, nspOid, extOid, { name: 'uuid_generate_v7', argtypes: [], rettype: TypeOid.uuid, src: 'uuidv7', volatile: 'v' });
    },
  },
  pgcrypto: {
    version: '1.3',
    install(session, cat, nspOid, extOid) {
      addProc(session, cat, nspOid, extOid, { name: 'gen_random_uuid', argtypes: [], rettype: TypeOid.uuid, src: 'gen_random_uuid', volatile: 'v' });
    },
  },
  plpgsql: {
    version: '1.0',
    install() {
      // always installed
    },
  },
};

export function createExtension(session: Session, stmt: A.CreateExtensionStmt): string {
  const cat = session.ddlCatalog();
  const existing = [...cat.extensions.values()].find((e) => e.name === stmt.name);
  if (existing) {
    if (stmt.ifNotExists) {
      return 'CREATE EXTENSION';
    }
    throw new PgError(SqlState.DUPLICATE_OBJECT, `extension "${stmt.name}" already exists`);
  }
  const spec = EXTENSIONS[stmt.name];
  if (!spec) {
    throw new PgError(SqlState.UNDEFINED_FILE, `extension "${stmt.name}" is not available`, {
      hint: 'The extension must first be installed on the system where PostgreSQL is running.',
    });
  }
  let nspOid = NS_PUBLIC;
  if (stmt.schema) {
    const ns = cat.findNamespace(stmt.schema);
    if (!ns) {
      throw new PgError(SqlState.UNDEFINED_SCHEMA, `schema "${stmt.schema}" does not exist`);
    }
    nspOid = ns.oid;
  } else {
    nspOid = session.creationNamespace();
  }
  const oid = session.db.oids.allocate();
  cat.extensions.set(oid, { oid, name: stmt.name, nspOid, version: stmt.version ?? spec.version });
  spec.install(session, cat, nspOid, oid);
  cat.invalidate();
  return 'CREATE EXTENSION';
}
