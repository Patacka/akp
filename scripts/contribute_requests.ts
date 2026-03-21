
import { v7 as uuidv7 } from 'uuid';
import { KUStore } from './src/core/store.ts';
import { createKU, createClaim, createProvenance } from './src/core/ku.ts';

async function run() {
  const identity = {
    did: 'did:key:zc04d27501ae92c2a8c19afb4bcc6ba5d83ca0692b35e2c203ec2f7ab3407c8e0',
    privateKeyHex: '25802ecc4553f1b4fdc6fb83e30c71dafd441edfd0eda09396526729f448194a'
  };

  const pypiRes = await fetch('https://pypi.org/pypi/requests/json').then(r => r.json());
  const osvRes = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { name: 'requests', ecosystem: 'PyPI' } })
  }).then(r => r.json());

  const version = pypiRes.info.version;
  const requires_python = pypiRes.info.requires_python;
  const vulnsCount = osvRes.vulns ? osvRes.vulns.length : 0;

  const store = new KUStore({ dbPath: './data/akp.db' });
  const now = new Date().toISOString();
  const validUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const prov = createProvenance({
    did: identity.did,
    type: 'agent',
    method: 'retrieval',
    model: 'gemini-cli',
    sources: [
      { id: uuidv7(), type: 'url', value: 'https://pypi.org/pypi/requests/json', title: 'PyPI requests' },
      { id: uuidv7(), type: 'url', value: 'https://api.osv.dev/v1/query', title: 'OSV requests' }
    ]
  });

  const ku = createKU({
    domain: 'python-packages',
    title: { en: 'requests package facts' },
    summary: 'Verifiable facts about the requests library.',
    provenance: prov
  });

  ku.structured.claims = [
    createClaim({
      type: 'temporal',
      subject: 'requests',
      predicate: 'latest_stable_version',
      object: version,
      confidence: 0.99,
      validFrom: now,
      validUntil: validUntil,
      provenanceRef: prov.id,
      verificationProcedure: {
        type: 'query',
        runtime: 'curl',
        executable: 'curl -s https://pypi.org/pypi/requests/json',
        expectedResult: version
      }
    }),
    createClaim({
      type: 'factual',
      subject: 'requests',
      predicate: 'has_known_cve',
      object: vulnsCount > 0,
      confidence: 0.95,
      validFrom: now,
      validUntil: validUntil,
      provenanceRef: prov.id,
      verificationProcedure: {
        type: 'query',
        runtime: 'curl',
        executable: 'curl -s -X POST https://api.osv.dev/v1/query -H "Content-Type: application/json" -d \'{"package":{"name":"requests","ecosystem":"PyPI"}}\'',
        expectedResult: vulnsCount
      }
    }),
    createClaim({
      type: 'quantitative',
      subject: 'requests',
      predicate: 'requires_python',
      object: requires_python,
      confidence: 0.99,
      provenanceRef: prov.id,
      verificationProcedure: {
        type: 'query',
        runtime: 'curl',
        executable: 'curl -s https://pypi.org/pypi/requests/json',
        expectedResult: requires_python
      }
    })
  ];

  const kuId = store.create(ku);
  console.log('Created KU:', kuId);
}

run().catch(console.error);
