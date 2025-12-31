function generateClientId(): number {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}

export function getClientId(collection: string): string {
  const key = `replicate:clientId:${collection}`;

  if (typeof localStorage === "undefined") {
    return String(generateClientId());
  }

  const stored = localStorage.getItem(key);
  if (stored) {
    return stored;
  }

  const clientId = String(generateClientId());
  localStorage.setItem(key, clientId);
  return clientId;
}
