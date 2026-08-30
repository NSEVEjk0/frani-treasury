/** throwaway: cryptographically verify the two paid deliverables' signatures round-trip (gitignored) */
import { verifySignedMessage } from '@unicitylabs/sphere-sdk';

const cases = [
  {
    label: 'market-digest proof-of-time',
    msg: 'market-digest\n2026-08-25T06:46:20.913Z\n5844b7b5eea62642594be512642fa4a72f989f5de159e1b2f34a0cec57d4f110',
    sig: '1fa268a6bf42d6d71422013a72bd3295a00b37e3e00a353c389377cc9bba879ce13702dfa3a5e015873c3e36880b40dd7a114feea3cc8dbb57d0a8864f0772983c',
    key: '02fb1491e118aed2dfa96f8602ba2f17c3df67b5ee614d095684b85876d01cdd13',
  },
  {
    label: 'frani-agent notary',
    msg: 'frani-agent-notary\n2026-08-25T06:46:30.904Z\nCRYPTFRANI external test proof 2026-08-25',
    sig: '1feef6f5064270622283c1ca50309c46dfb3e1b946fb2204399a259df95a6436ab626fde4438f96515e8540bb974f4aac9595ec5e7c713ebbf2da2821093151fdd',
    key: '035c9f07b623475efe9a76719ffe36e4475d52debe200413fc454882bb6cd82e27',
  },
];

for (const c of cases) {
  try {
    const ok = await verifySignedMessage(c.msg, c.sig, c.key);
    console.log(`${ok ? '✅ VALID  ' : '❌ INVALID'}  ${c.label}`);
    // negative control: tamper one char of the message → must fail
    const tampered = c.msg.slice(0, -1) + (c.msg.slice(-1) === '0' ? '1' : '0');
    const bad = await verifySignedMessage(tampered, c.sig, c.key);
    console.log(`   tamper-check (must be false): ${bad}`);
  } catch (e) {
    console.log(`⚠️  ${c.label}: verify threw — ${e?.message ?? e}`);
  }
}
process.exit(0);
