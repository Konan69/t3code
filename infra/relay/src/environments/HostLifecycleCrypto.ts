const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64UrlEncode = (value: ArrayBuffer | Uint8Array): string =>
  Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString("base64url");

const base64UrlDecode = (value: string): ArrayBuffer => {
  const bytes = Buffer.from(value, "base64url");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const encryptionKey = async (keyMaterial: string): Promise<CryptoKey> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(keyMaterial));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
};

export async function encryptHostLifecycleSecret(input: {
  readonly keyMaterial: string;
  readonly environmentId: string;
  readonly secret: string;
}): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(input.environmentId),
    },
    await encryptionKey(input.keyMaterial),
    encoder.encode(input.secret),
  );
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
}

export async function decryptHostLifecycleSecret(input: {
  readonly keyMaterial: string;
  readonly environmentId: string;
  readonly ciphertext: string;
}): Promise<string> {
  const [version, encodedIv, encodedCiphertext, extra] = input.ciphertext.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext || extra !== undefined) {
    throw new Error("Invalid host lifecycle ciphertext");
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlDecode(encodedIv),
      additionalData: encoder.encode(input.environmentId),
    },
    await encryptionKey(input.keyMaterial),
    base64UrlDecode(encodedCiphertext),
  );
  return decoder.decode(plaintext);
}
