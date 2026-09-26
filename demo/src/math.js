export function add(a, b) {
  return a - b;
}

export function average(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
