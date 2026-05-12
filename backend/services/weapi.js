/**
 * 网易云 weapi 加密：AES-128-CBC + RSA。
 * 仅用于 VIP 歌曲播放地址的 fallback。
 */
import { createCipheriv, createPublicKey, randomBytes, publicEncrypt, constants } from 'crypto';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const MODULUS_HEX = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const EXP_HEX = '010001';

const toB64Url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const PUBLIC_KEY = createPublicKey({
  key: {
    kty: 'RSA',
    n: toB64Url(Buffer.from(MODULUS_HEX, 'hex')),
    e: toB64Url(Buffer.from(EXP_HEX, 'hex')),
  },
  format: 'jwk',
});

function aesEncrypt(text, key) {
  const cipher = createCipheriv('aes-128-cbc', key, IV);
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function rsaEncrypt(text) {
  const reversed = Buffer.from(text.split('').reverse().join(''), 'utf8');
  const padded = Buffer.concat([Buffer.alloc(128 - reversed.length, 0), reversed]);
  return publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_NO_PADDING }, padded).toString('hex');
}

/**
 * 把 payload 加密成 weapi 请求体（application/x-www-form-urlencoded）。
 */
export function buildWeapiBody(payload) {
  const text = JSON.stringify(payload);
  const secret = randomBytes(8).toString('hex'); // 16 chars
  const params = aesEncrypt(aesEncrypt(text, PRESET_KEY), secret);
  const encSecKey = rsaEncrypt(secret);
  return `params=${encodeURIComponent(params)}&encSecKey=${encodeURIComponent(encSecKey)}`;
}
