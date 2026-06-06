import type { SyncReviewPosition } from '../../src/adapter/types'

describe('SyncReviewPosition discriminated union', () => {
  it('text position has correct shape', () => {
    const pos: SyncReviewPosition = {
      positionType: 'text',
      filePath: 'src/foo.ts',
      oldLine: 10,
      newLine: 12,
      baseSha: 'aaaa',
      headSha: 'bbbb',
      startSha: 'cccc'
    }
    expect(pos.positionType).toBe('text')
    expect(pos.filePath).toBe('src/foo.ts')
    if (pos.positionType === 'text') {
      expect(pos.oldLine).toBe(10)
      expect(pos.newLine).toBe(12)
      expect(pos.startSha).toBe('cccc')
    }
  })

  it('image position has correct shape', () => {
    const pos: SyncReviewPosition = {
      positionType: 'image',
      filePath: 'assets/logo.png',
      x: 10,
      y: 20,
      width: 100,
      height: 50,
      baseSha: 'aaaa',
      headSha: 'bbbb'
    }
    expect(pos.positionType).toBe('image')
    expect(pos.filePath).toBe('assets/logo.png')
    if (pos.positionType === 'image') {
      expect(pos.x).toBe(10)
      expect(pos.y).toBe(20)
      expect(pos.width).toBe(100)
      expect(pos.height).toBe(50)
    }
  })

  it('file position has correct shape', () => {
    const pos: SyncReviewPosition = {
      positionType: 'file',
      filePath: 'README.md',
      baseSha: 'aaaa',
      headSha: 'bbbb'
    }
    expect(pos.positionType).toBe('file')
    expect(pos.filePath).toBe('README.md')
  })

  it('all variants share filePath', () => {
    const positions: SyncReviewPosition[] = [
      { positionType: 'text', filePath: 'a.ts', oldLine: null, newLine: 1, baseSha: 'a', headSha: 'b', startSha: 'c' },
      { positionType: 'image', filePath: 'b.png', x: 0, y: 0, width: 1, height: 1, baseSha: 'a', headSha: 'b' },
      { positionType: 'file', filePath: 'c.md', baseSha: 'a', headSha: 'b' }
    ]
    for (const p of positions) {
      expect(typeof p.filePath).toBe('string')
    }
  })
})
