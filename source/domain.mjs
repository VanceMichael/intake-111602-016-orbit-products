export function dispatch({ url, phase }) {
  if (url.pathname === '/releases') return { json: { releasedAt: phase ? '2026-10-15T00:00:00Z' : '2026-10-13T00:00:00Z', releases: [
    { id: 'rapid-a', orbit: '/products/rapid.sp3', agency: 'lab-igs', solution: 'rapid', frame: phase ? 'IGb20' : 'IGS20', timeSystem: 'GPS', clock: '/products/rapid.clk' },
    ...(phase ? [{ id: 'final-b', orbit: '/products/final.sp3', agency: 'other', solution: 'final', frame: 'IGb20', timeSystem: 'GPS' }] : []) ] } };
  return null;
}
