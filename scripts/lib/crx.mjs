/*
** CRX3 packaging: the signed format Chrome installs extensions from.
**
**     "Cr24"  uint32le 3  uint32le headerSize  CrxFileHeader  ZIP archive
**
** CrxFileHeader is a protobuf (components/crx_file/crx3.proto in Chromium):
**
**     message CrxFileHeader {
**       repeated AsymmetricKeyProof sha256_with_rsa = 2;
**       bytes signed_header_data = 10000;          // a serialized SignedData
**     }
**     message AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
**     message SignedData { bytes crx_id = 1; }     // first 16 bytes of SHA-256(public key)
**
** The signature is RSASSA-PKCS1-v1_5 with SHA-256 over
**
**     "CRX3 SignedData\0"  uint32le len(signed_header_data)  signed_header_data  archive
**
** The public key is the DER SubjectPublicKeyInfo. The extension ID is the
** same 16 bytes written in hex with the digits 0-f mapped to the letters a-p.
*/
import crypto from 'node:crypto';

const MAGIC = Buffer.from('Cr24');
const VERSION = 3;
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\0');
const HEADER_PROOFS = 2;
const HEADER_SIGNED_DATA = 10000;
const PROOF_KEY = 1;
const PROOF_SIGNATURE = 2;
const SIGNED_CRX_ID = 1;

function varint(value) {
  const bytes = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}
/* A length-delimited protobuf field (wire type 2). */
function field(number, bytes) {
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

/* Parse the length-delimited fields of one protobuf message: [{ number, bytes }]. */
function fields(buffer) {
  const out = [];
  let at = 0;
  const read = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (at >= buffer.length) throw new Error('truncated protobuf');
      const byte = buffer[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  while (at < buffer.length) {
    const tag = read();
    if ((tag & 7) !== 2) throw new Error(`unexpected protobuf wire type ${tag & 7}`);
    const length = read();
    if (at + length > buffer.length) throw new Error('truncated protobuf');
    out.push({ number: Math.floor(tag / 8), bytes: buffer.subarray(at, at + length) });
    at += length;
  }
  return out;
}

const signedPayload = (signedData, archive) => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length);
  return Buffer.concat([SIGNATURE_CONTEXT, length, signedData, archive]);
};

export function publicKeyDer(privateKeyPem) {
  return crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
}

/* The 32-letter extension ID Chrome derives from a public key (DER SPKI). */
export function extensionId(publicKey) {
  const digest = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  return [...digest.toString('hex')].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/* Sign a ZIP archive into a CRX3 file. privateKeyPem: an RSA private key in PEM. */
export function createCrx(archive, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'rsa') throw new Error('the CRX signing key must be an RSA key');
  const publicKey = publicKeyDer(key);
  const crxId = crypto.createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signedData = field(SIGNED_CRX_ID, crxId);
  const signature = crypto.sign('sha256', signedPayload(signedData, archive), key);
  const header = Buffer.concat([
    field(HEADER_PROOFS, Buffer.concat([field(PROOF_KEY, publicKey), field(PROOF_SIGNATURE, signature)])),
    field(HEADER_SIGNED_DATA, signedData),
  ]);
  const prefix = Buffer.alloc(12);
  MAGIC.copy(prefix, 0);
  prefix.writeUInt32LE(VERSION, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}

/*
** Verify a CRX3 file the way Chrome does for its RSA proofs: the declared
** ID must match one of the keys, and every RSA proof must verify. Returns
** { id, archive } or throws.
*/
export function verifyCrx(crx) {
  if (crx.length < 12 || !crx.subarray(0, 4).equals(MAGIC)) throw new Error('not a CRX file');
  if (crx.readUInt32LE(4) !== VERSION) throw new Error(`unsupported CRX version ${crx.readUInt32LE(4)}`);
  const headerEnd = 12 + crx.readUInt32LE(8);
  if (headerEnd > crx.length) throw new Error('truncated CRX header');
  const header = fields(crx.subarray(12, headerEnd));
  const archive = crx.subarray(headerEnd);

  const signedData = header.find(f => f.number === HEADER_SIGNED_DATA)?.bytes;
  const crxId = signedData && fields(signedData).find(f => f.number === SIGNED_CRX_ID)?.bytes;
  if (!crxId || crxId.length !== 16) throw new Error('CRX has no signed ID');

  const proofs = header.filter(f => f.number === HEADER_PROOFS).map(f => {
    const parts = fields(f.bytes);
    return {
      key: parts.find(p => p.number === PROOF_KEY)?.bytes,
      signature: parts.find(p => p.number === PROOF_SIGNATURE)?.bytes,
    };
  });
  if (!proofs.length) throw new Error('CRX has no RSA signature');
  let id = null;
  for (const { key, signature } of proofs) {
    if (!key || !signature) throw new Error('incomplete CRX signature');
    const publicKey = crypto.createPublicKey({ key, format: 'der', type: 'spki' });
    if (!crypto.verify('sha256', signedPayload(signedData, archive), publicKey, signature)) {
      throw new Error('CRX signature does not verify');
    }
    const digest = crypto.createHash('sha256').update(key).digest().subarray(0, 16);
    if (digest.equals(crxId)) id = extensionId(key);
  }
  if (!id) throw new Error('CRX ID does not match any signing key');
  return { id, archive };
}
