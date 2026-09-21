/** Latest seven daily copies plus the latest representative from each of three represented months. */
export function retainedBackupKeys(
  records: { id: string; created_at: number | string }[],
) {
  const sorted = [...records].sort(
    (a, b) =>
      Number(b.created_at) - Number(a.created_at) || b.id.localeCompare(a.id),
  );
  const keep = new Set(sorted.slice(0, 7).map((record) => record.id)),
    months = new Set<string>();
  for (const record of sorted) {
    const month = new Date(Number(record.created_at)).toISOString().slice(0, 7);
    if (!months.has(month) && months.size < 3) {
      months.add(month);
      keep.add(record.id);
    }
  }
  return keep;
}
