// Test-only transport adapter. Every read/RPC executes production SQL under the
// fixture's authenticated PostgreSQL role and RLS; no ranking rows are invented.
const tables = new Set(['companies','recruitments','positions','applications','screening_analysis_versions','screening_result_reviews','screening_criterion_results','screening_criterion_review_overrides']);
const functions = new Set(['get_screening_ranking','get_recruitment_shortlist']);
const identifier = value => { if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid test SQL identifier'); return '"'+value+'"'; };
export function reportDatabaseClient(db, getUser, beforeRead = async () => {}) {
  const reads = [];
  function query(table, args) {
    const filters = [], orders = []; let fields = '*', offset = 0, limit = 100, single = false;
    const chain = {
      select(value) { fields = value.split(',').map(identifier).join(','); return this; },
      eq(key,value) { filters.push([key,value,false]); return this; },
      in(key,value) { filters.push([key,value,true]); return this; },
      order(key, options) { orders.push(identifier(key)+(options?.ascending===false?' desc':' asc')); return this; },
      range(from,to) { offset=from; limit=Math.min(to-from+1,2); return this; },
      maybeSingle() { single=true; return this; },
      async then(resolve,reject) {
        try {
          await beforeRead(table);
          reads.push({table,fields,filters:structuredClone(filters),offset,limit});
          const values = []; const parameter = value => { values.push(value); return '$'+values.length; };
          const source = args
            ? 'public.'+identifier(table)+'('+Object.entries(args).map(([key,value])=>identifier(key)+' => '+parameter(value)).join(',')+')'
            : 'public.'+identifier(table);
          const where = filters.map(([key,value,many])=>identifier(key)+(many?' = any('+parameter(value)+')':' = '+parameter(value))).join(' and ');
          const sql = 'select row_to_json(result) as row from (select '+fields+' from '+source+(where?' where '+where:'')+(orders.length?' order by '+orders.join(','):'')+' limit '+parameter(limit)+' offset '+parameter(offset)+') result';
          const rows = (await db.query(sql,values)).rows.map(r=>r.row);
          return resolve({data:single?(rows[0]??null):rows,error:null});
        } catch(error) { return resolve({data:null,error:{code:error.code??'TEST_ADAPTER_ERROR',message:error.message}}); }
      },
    };
    return chain;
  }
  return { reads, auth:{async getUser(){return {data:{user:getUser()},error:null};}},
    from(table) { if(!tables.has(table)) throw Error('Unexpected test table '+table); return query(table); },
    rpc(name,args) { if(!functions.has(name)) throw Error('Unexpected test RPC '+name); return query(name,args); },
  };
}
