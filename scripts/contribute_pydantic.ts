
import { v7 as uuidv7 } from 'uuid';
import { KUStore } from './src/core/store.ts';
import { createKU, createClaim, createProvenance } from './src/core/ku.ts';

async function run() {
  const identity = {
    did: 'did:key:zc04d27501ae92c2a8c19afb4bcc6ba5d83ca0692b35e2c203ec2f7ab3407c8e0',
    privateKeyHex: '25802ecc4553f1b4fdc6fb83e30c71dafd441edfd0eda09396526729f448194a'
  };

  const package_name = 'pydantic';
  const pypiRes = await fetch(`https://pypi.org/pypi/${package_name}/json`).then(r => r.json());
  const osvRes = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ package: { name: package_name, ecosystem: 'PyPI' } })
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
      { id: uuidv7(), type: 'url', value: `https://pypi.org/pypi/${package_name}/json`, title: `PyPI ${package_name}` },
      { id: uuidv7(), type: 'url', value: 'https://api.osv.dev/v1/query', title: `OSV ${package_name}` }
    ]
  });

  const ku = createKU({
    domain: 'python-packages',
    title: { en: `${package_name} package facts` },
    summary: `Verifiable facts about the ${package_name} library.`,
    provenance: prov
  });

  ku.structured.claims = [
    createClaim({
      type: 'temporal',
      subject: package_name,
      predicate: 'latest_stable_version',
      object: version,
      confidence: 0.99,
      validFrom: now,
      validUntil: validUntil,
      provenanceRef: prov.id,
      verificationProcedure: {
        type: 'query',
        runtime: 'curl',
        executable: `curl -s https://pypi.org/pypi/${package_name}/json`,
        expectedResult: version
      }
    }),
    createClaim({
      type: 'factual',
      subject: package_name,
      predicate: 'has_known_cve',
      object: vulnsCount > 0,
      confidence: 0.95,
      validFrom: now,
      validUntil: validUntil,
      provenanceRef: prov.id,
      verificationProcedure: {
        type: 'query',
        runtime: 'curl',
        executable: `curl -s -X POST https://api.osv.dev/v1/query -H "Content-Type: application/json" -d '{\"package\":{\"name\":\"${package_name}\",\"ecosystem\":\"PyPI\"}}'`,
        expectedResult: vulnsCount
      }
    }),
    createClaim({
      type: 'quantitative',
      subject: package_name,
      predicate: 'requires_python',
      object: requires_python,
      confidence: 0.99,
      provenanceRef: prov.id,
      verificationProcedure: {
        type: 'query',
        runtime: 'curl',
        executable: `curl -s https://pypi.org/pypi/${package_name}/json`,
        expectedResult: requires_python
      }
    })
  ];

  const kuId = store.create(ku);
  console.log('Created KU:', kuId);
}

run().catch(console.error);
