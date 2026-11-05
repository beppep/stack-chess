// Password hashing with WebCrypto (PBKDF2-SHA-256), hex strings throughout.
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = s => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));

export const newSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(salt), iterations: 100000 }, key, 256);
  return hex(bits);
}

// Compare without stopping at the first difference.
export async function checkPassword(password, salt, hash) {
  const got = await hashPassword(password, salt);
  if (typeof hash !== 'string' || hash.length !== got.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}
