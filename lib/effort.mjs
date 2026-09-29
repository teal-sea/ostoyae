export function validateEffort(value, name = 'effort') {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,20}$/.test(value))
    throw new Error(`${name} must match ^[a-z0-9_-]{1,20}$`);
  return value;
}

export function effectiveEffort(params = {}) {
  return params.effort ?? params.reasoning_effort;
}
