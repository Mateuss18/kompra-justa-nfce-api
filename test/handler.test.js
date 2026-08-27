const assert = require('node:assert/strict')

const { handler } = require('../dist/handler')

async function testUnsupportedState() {
  const result = await handler({ body: JSON.stringify({ url: 'https://nfce.fazenda.mg.gov.br/nota' }) })

  assert.equal(result.statusCode, 422)
  assert.deepEqual(JSON.parse(result.body), {
    code: 'UNSUPPORTED_STATE',
    error: 'Ainda não oferecemos suporte para notas fiscais deste estado.'
  })
}

testUnsupportedState().catch(error => {
  console.error(error)
  process.exitCode = 1
})
