export async function completeComparison(request, root, base, head) {
  const fail = () => { throw new Error('PROMOTION_DIFF_INCOMPLETE'); };
  if (![base, head].every(x => /^[a-f0-9]{40}$/.test(x))) fail();
  const path = `${root}/compare/${base}...${head}`;
  const first = await request(`${path}?per_page=100&page=1`);
  if (!Number.isSafeInteger(first.total_commits) || first.total_commits < 0 || !Array.isArray(first.commits) || !Array.isArray(first.files)) fail();
  const commits = [...first.commits];
  for (let page = 2; commits.length < first.total_commits; page++) {
    if (page > 100 || commits.length !== (page - 1) * 100) fail();
    const next = await request(`${path}?per_page=100&page=${page}`);
    if (next.total_commits !== first.total_commits || !Array.isArray(next.commits) || !next.commits.length) fail();
    commits.push(...next.commits);
  }
  if (commits.length !== first.total_commits || new Set(commits.map(c => c.sha)).size !== commits.length || commits.some(c => !/^[a-f0-9]{40}$/.test(c.sha))) fail();
  let files = first.files;
  if (files.length >= 300) {
    // Compare responses cap files at 300. Complete immutable trees retain all
    // changed paths, including deletions and both sides of renames.
    const trees = await Promise.all([base, head].map(async sha => {
      const tree = await request(`${root}/git/trees/${sha}?recursive=1`);
      if (tree.truncated !== false || !Array.isArray(tree.tree)) fail();
      const entries = tree.tree.filter(e => e.type !== 'tree');
      if (entries.some(e => typeof e.path !== 'string' || typeof e.sha !== 'string' || typeof e.mode !== 'string') || new Set(entries.map(e => e.path)).size !== entries.length) fail();
      return new Map(entries.map(e => [e.path, `${e.mode}:${e.type}:${e.sha}`]));
    }));
    files = [...new Set([...trees[0].keys(), ...trees[1].keys()])].sort().filter(p => trees[0].get(p) !== trees[1].get(p)).map(filename => ({ filename }));
  }
  return { ...first, commits, files };
}
