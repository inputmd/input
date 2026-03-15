export interface RecentLinearCommit {
  sha: string;
  parents: string[];
}

export interface CommitCompactionSelection {
  baseParentSha: string;
  headSha: string;
  selectedCount: number;
  selectedShas: string[];
}

export function resolveCommitCompactionSelection(
  commits: RecentLinearCommit[],
  selectedShas: string[],
): CommitCompactionSelection {
  if (commits.length === 0) {
    throw new Error('No commits are available to compact');
  }

  const normalizedSelected = selectedShas.map((sha) => sha.trim()).filter(Boolean);
  if (normalizedSelected.length < 2) {
    throw new Error('Select at least two commits to compact');
  }

  const selectedSet = new Set<string>();
  for (const sha of normalizedSelected) {
    if (selectedSet.has(sha)) {
      throw new Error('Duplicate commits were selected');
    }
    selectedSet.add(sha);
  }

  const headSha = commits[0]?.sha;
  if (!headSha || !selectedSet.has(headSha)) {
    throw new Error('Compaction must include the current HEAD commit');
  }

  let prefixLength = 0;
  while (prefixLength < commits.length && selectedSet.has(commits[prefixLength]!.sha)) {
    prefixLength += 1;
  }
  for (let i = prefixLength; i < commits.length; i += 1) {
    if (selectedSet.has(commits[i]!.sha)) {
      throw new Error('Selected commits must form a contiguous range from HEAD');
    }
  }
  if (prefixLength !== selectedSet.size) {
    throw new Error('Some selected commits are not in the loaded history page');
  }

  const selectedCommits = commits.slice(0, prefixLength);
  for (const commit of selectedCommits) {
    if (commit.parents.length !== 1) {
      throw new Error('Merge commits and root commits cannot be compacted');
    }
  }

  const oldestSelected = selectedCommits[selectedCommits.length - 1];
  const baseParentSha = oldestSelected?.parents[0];
  if (!baseParentSha) {
    throw new Error('Failed to resolve the parent commit for compaction');
  }

  return {
    baseParentSha,
    headSha,
    selectedCount: selectedCommits.length,
    selectedShas: selectedCommits.map((commit) => commit.sha),
  };
}
