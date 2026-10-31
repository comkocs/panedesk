import { StringDecoder as NodeStringDecoder } from 'node:string_decoder'
import { expect, it } from 'vitest'
import { StringDecoder } from '../../src/node/builtin_modules/implemented/string_decoder.ts'

it('matches Node UTF-8 decoding across every byte split, including BOM and invalid tails', () => {
  for (const bytes of [Buffer.from('﻿中文🙂\n'), Buffer.from([0xe4, 0xb8]), Buffer.from([0xff, 0x61, 0xf0, 0x9f])]) {
    for (let split = 0; split <= bytes.length; split++) {
      const actual = new StringDecoder(), expected = new NodeStringDecoder('utf8')
      expect(actual.write(bytes.subarray(0, split))).toBe(expected.write(bytes.subarray(0, split)))
      expect(actual.end(bytes.subarray(split))).toBe(expected.end(bytes.subarray(split)))
      expect(actual.write(Buffer.from('next'))).toBe(expected.write(Buffer.from('next')))
      expect(actual.end()).toBe(expected.end())
    }
  }
})

it('passes decoded text through and rejects unsupported encodings', () => {
  expect(new StringDecoder('UTF-8').write('text')).toBe('text')
  expect(() => new StringDecoder('utf16le')).toThrow('does not support encoding')
})
