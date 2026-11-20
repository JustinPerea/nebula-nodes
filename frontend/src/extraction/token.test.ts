import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { forgetToken, takeToken } from './token'

describe('takeToken', () => {
  beforeEach(() => {
    forgetToken()
    window.history.replaceState(null, '', '/')
  })
  afterEach(() => {
    forgetToken()
    window.history.replaceState(null, '', '/')
  })

  it('takes the token from the fragment and clears the fragment', () => {
    window.history.replaceState(null, '', '/#token=abc_DEF-123')
    expect(takeToken()).toBe('abc_DEF-123')
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain('abc_DEF-123')
  })

  it('keeps the path and query when it clears the fragment', () => {
    window.history.replaceState(null, '', '/extraction.html?x=1#token=tok')
    takeToken()
    expect(window.location.pathname + window.location.search).toBe('/extraction.html?x=1')
    expect(window.location.hash).toBe('')
  })

  it('keeps the token in this tab for a reload', () => {
    window.history.replaceState(null, '', '/#token=kept')
    takeToken()
    expect(window.sessionStorage.getItem('extraction.token')).toBe('kept')
    expect(takeToken()).toBe('kept')
  })

  it('has no token without a fragment or a kept one', () => {
    expect(takeToken()).toBeNull()
  })

  it('still works when storage is blocked', () => {
    const real = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
    try {
      window.history.replaceState(null, '', '/#token=memory')
      expect(takeToken()).toBe('memory')
      expect(window.location.hash).toBe('')
    } finally {
      Storage.prototype.setItem = real
    }
  })

  it('ignores a fragment that is not a token', () => {
    window.history.replaceState(null, '', '/#other=1')
    expect(takeToken()).toBeNull()
  })
})
