export function decode(bytes) {
  const lines = bytes.toString('ascii').trimEnd().split(/\r?\n/);
  if (!/^#[cd][PV]/.test(lines[0]) || lines.at(-1) !== 'EOF') throw new Error('不是完整 SP3 产品');
  const header = lines[0];
  const epochs = [];
  let current = null;
  for (const line of lines.slice(1)) {
    if (line.startsWith('*')) {
      const parts = line.slice(1).trim().split(/\s+/).map(Number);
      current = { fields: parts, satellites: [] }; epochs.push(current);
    } else if (line.startsWith('P')) {
      if (!current) throw new Error('卫星资料缺少历元');
      const fields = [line.slice(4, 18), line.slice(18, 32), line.slice(32, 46), line.slice(46, 60)].map(Number);
      if (!fields.every(Number.isFinite)) throw new Error('卫星数值无效');
      current.satellites.push({ id: line.slice(1, 4), positionKm: fields.slice(0, 3), clockMicroseconds: fields[3], flags: line.slice(60) });
    }
  }
  return { revision: header[1], product: header.slice(3), timeSystem: lines.find(line => line.startsWith('%c')) || null, epochs };
}
