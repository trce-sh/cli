import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { duplicateCandidates, jaccard, keywordCategory, wordShingles } from './analysis.js'
import { scanInventory } from './inventory.js'

describe('duplicate analysis cache', () => {
  it('preserves the uncached pair scores and ordering', async () => {
    const skills = await scanInventory({
      env: {},
      homeDirectory: fileURLToPath(new URL('../fixtures/home-synthetic/', import.meta.url)),
    })
    const locations = skills.filter(
      (skill, index) =>
        skills.findIndex(
          (candidate) =>
            candidate.realDirectory === skill.realDirectory &&
            candidate.fingerprint === skill.fingerprint,
        ) === index,
    )
    const expected = locations
      .flatMap((left, index) =>
        locations.slice(index + 1).flatMap((right) => {
          const similarity = jaccard(
            wordShingles(left.skillMdText),
            wordShingles(right.skillMdText),
          )
          return left.name !== right.name && similarity > 0.3
            ? [{ left: left.name, right: right.name, similarity }]
            : []
        }),
      )
      .toSorted((left, right) => right.similarity - left.similarity)
    expect(expected.length).toBeGreaterThan(0)
    expect(
      duplicateCandidates(skills).map(({ left, right, similarity }) => ({
        left: left.name,
        right: right.name,
        similarity,
      })),
    ).toEqual(expected)
  })
})

describe('skill text normalization', () => {
  it('lowercases with the invariant mapping so shingles and categories match across locales', () => {
    // A locale-aware lowercase turns the capital I of "SECURITY AUDIT" into a dotless ı under a
    // Turkish or Azeri host locale, which the shingle regex then strips into a word break. The
    // similarity sent as `word-5-shingle-jaccard@1` and the fallback category must not depend on
    // the laptop's locale.
    expect(keywordCategory('SECURITY AUDIT', null)).toBe('security')
    expect(keywordCategory('Review', 'Checks the UI for SHADCN mistakes')).toBe('frontend-design')
    expect([...wordShingles('I Fix It In Six Simple Steps', 3)]).toEqual([
      'i fix it',
      'fix it in',
      'it in six',
      'in six simple',
      'six simple steps',
    ])
  })
})

describe('keyword category fallback', () => {
  it.each(['email', 'emails', 'newsletter', 'newsletters', 'drip', 'nurture'])(
    'files %s skills under Marketing and content',
    (keyword) => {
      expect(keywordCategory(`${keyword}-sequence`, 'Plan a campaign.')).toBe('marketing-content')
    },
  )

  it('labels the skills the 2026-08-30 laptop report mislabeled', () => {
    // The report printed devops-infra: bare `ci` matched inside "pricing".
    expect(
      keywordCategory(
        'copywriting',
        'Write, rewrite, or improve marketing copy for homepage, landing, pricing, and feature pages.',
      ),
    ).toBe('writing')
    // The report printed security: generic `audit` beat the more specific `seo`.
    expect(keywordCategory('seo-audit', 'Audit, review, or diagnose SEO issues on a site.')).toBe(
      'marketing-content',
    )
    // The report printed databases: a request-schema mention beat the docs-shaped name.
    expect(
      keywordCategory(
        'openai-docs',
        'Reference for the OpenAI API: endpoints, request schemas, models, and streaming.',
      ),
    ).toBe('docs-release')
    expect(
      keywordCategory(
        'vercel-react-best-practices',
        'Best practices for writing fast applications from Vercel Engineering.',
      ),
    ).toBe('frontend-design')
    expect(keywordCategory('shadcn', 'Documentation and usage examples.')).toBe('frontend-design')
    expect(keywordCategory('pricing-strategy', 'Analyze product data and costs.')).toBe(
      'product-planning',
    )
  })

  it('labels the fixture-home skills and defaults to other instead of guessing', () => {
    expect(
      keywordCategory(
        'pr-review',
        'Reviews pull requests for correctness, test coverage, security, and maintainability.',
      ),
    ).toBe('security')
    expect(
      keywordCategory(
        'code-review',
        'Reviews pull requests for correctness, test coverage, security, and maintainability.',
      ),
    ).toBe('security')
    expect(
      keywordCategory(
        'pr-review',
        'Reviews pull requests for correctness, coverage, and maintainability using current team rules.',
      ),
    ).toBe('code-quality')
    // `data` no longer matches inside "metadata"; the name names a release document.
    expect(
      keywordCategory('release-notes', 'Writes concise release notes from approved metadata.'),
    ).toBe('docs-release')
    expect(keywordCategory('legacy-helper', null)).toBe('other')
  })
})
