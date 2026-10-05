import { BrowserProvider, JsonRpcProvider, Contract, isAddress } from './ethers.js';

const config = await (await fetch('./config.json')).json();
const abi = await (await fetch('./abi.json')).json();

// Index = role number in the contract.
const ROLE_NAMES = ['Unregistered', 'Auditor', 'Farm', 'Processor', 'Distributor'];

let readContract;   // read only, no wallet
let writeContract;  // signs with MetaMask

const $ = id => document.getElementById(id);
const errorText = err => err.shortMessage || err.reason || err.message || String(err);
// Readable local date.
const asDate = seconds =>
  new Date(Number(seconds) * 1000).toLocaleDateString('en-NZ',
    { day: 'numeric', month: 'long', year: 'numeric' });

// Short address.
const shortAddress = address => `${address.slice(0, 6)}…${address.slice(-4)}`;

// Make an element.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Built on first use
async function getReadContract() {
  if (!readContract) {
    if (!isAddress(config.contractAddress)) {
      throw Error('Setup needed: paste the deployed contract address into dist/config.json and refresh.');
    }
    const rpc = new JsonRpcProvider(config.rpcUrl);
    if (Number((await rpc.getNetwork()).chainId) !== config.chainId) {
      throw Error('Read RPC is not Sepolia. Check config.json.');
    }
    if (await rpc.getCode(config.contractAddress) === '0x') {
      throw Error('No contract at configured address. Check deployment.');
    }
    readContract = new Contract(config.contractAddress, abi, rpc);
  }
  return readContract;
}

// Consumer lookup (no wallet)
async function lookupBatch(id) {
  const contract = await getReadContract();
  const product = await contract.getProduct(id);

  // Fetch lots in parallel.
  const lots = await Promise.all(
    product.milkIds.map(async milkId => {
      const lot = await contract.milk(milkId);
      // Copy fields; a Result can't be spread.
      return {
        id: milkId,
        farm: lot.farm,
        litres: lot.litres,
        certificateId: lot.certificateId,
        createdAt: lot.createdAt,
      };
    })
  );

  // Fetch each audit once.
  const certIds = [...new Set(lots.map(lot => lot.certificateId).filter(cert => cert !== 0n))];
  const certList = await Promise.all(certIds.map(certId => contract.certificates(certId)));
  const certs = new Map(certIds.map((certId, i) => [certId, certList[i]]));

  const farms = [...new Set(lots.map(lot => lot.farm))];
  const out = [];

  // Verdict
  const verdict = el('div', `verdict ${product.certified ? 'is-pass' : 'is-fail'}`);
  verdict.append(
    el('p', 'verdict-title', product.certified
      ? 'Eligible under the demo fair-trade rule'
      : 'Not eligible under the demo fair-trade rule'),
    el('p', 'verdict-meta',
      `Batch ${id} · ${product.litres} litres · pooled ${asDate(product.createdAt)}`));
  out.push(verdict);

  // Summary
  const lotWord = `${lots.length} milk lot${lots.length === 1 ? '' : 's'}`;
  const farmWord = `${farms.length} farm${farms.length === 1 ? '' : 's'}`;
  const uncertified = lots.filter(lot => lot.certificateId === 0n).length;

  // Earliest audit expiry
  const expiries = [...certs.values()].map(cert => Number(cert.validUntil));
  const soonest = expiries.length ? asDate(Math.min(...expiries)) : null;

  out.push(el('p', 'summary', product.certified
    ? `Made from ${lotWord} from ${farmWord}, each covered by a farm audit valid until ${soonest}.`
    : `Made from ${lotWord} from ${farmWord}. ` +
      (uncertified === lots.length
        ? `None had a valid farm audit when registered.`
        : `${uncertified} of them had no valid farm audit when registered, ` +
          `and one uncertified lot makes the whole batch ineligible.`)));

  out.push(el('p', `receipt ${product.received ? 'ok' : 'waiting'}`, product.received
    ? 'Receipt confirmed by the distributor.'
    : 'The distributor has not yet confirmed receipt.'));

  // Full record
  const full = el('details', 'full');
  full.append(el('summary', null, 'See the complete record'));

  const iso = seconds => new Date(Number(seconds) * 1000).toISOString();
  const raw = [
    `Product ${id}`,
    `Litres: ${product.litres}`,
    `Processor: ${product.processor}`,
    `Distributor: ${product.distributor}`,
    `Receipt confirmed: ${product.received ? 'Yes' : 'No'}`,
    `Recorded: ${iso(product.createdAt)}`,
    '',
    'Milk lots',
  ];

  for (const lot of lots) {
    raw.push(`  ${lot.id}: ${lot.litres} L; farm ${lot.farm}; ` +
      `audit ${lot.certificateId || 'none'}`);
  }

  if (certs.size) {
    raw.push('', 'Audits');
    for (const [certId, cert] of certs) {
      raw.push(
        `  ${certId}: auditor ${cert.auditor}`,
        `     issued ${iso(cert.issuedAt)}, expires ${iso(cert.validUntil)}`,
        `     document SHA-256 ${cert.evidenceHash}`);
    }
  }

  full.append(el('pre', null, raw.join('\n')));
  out.push(full);

  $('result').replaceChildren(...out);
}

// QR link: this page with ?id=
function labelUrl(productId) {
  return `${location.origin}${location.pathname}?id=${productId}`;
}

// Show the QR label.
function showLabel(productId) {
  $('labelText').textContent =
    `Print this on the packaging for product ${productId}. Scanning it opens the batch's public record.`;
  $('qr').replaceChildren();
  new QRCode($('qr'), { text: labelUrl(productId), width: 180, height: 180 });
  $('labelUrl').textContent = labelUrl(productId);
  $('label').hidden = false;
}

$('lookup').onsubmit = async event => {
  event.preventDefault();
  try {
    await lookupBatch(new FormData(event.target).get('id'));
  } catch (err) {
    $('result').textContent = errorText(err);
  }
};


// Stakeholder workspace (MetaMask)
const CREATION_EVENTS = ['Certified', 'MilkCreated', 'ProductCreated'];

// New record's ID, or null.
function idFromReceipt(receipt, eventName) {
  for (const log of receipt.logs) {
    const parsed = writeContract.interface.parseLog(log);
    if (parsed?.name === eventName) return parsed.args.id;
  }
  return null;
}

function newRecordIds(receipt) {
  return receipt.logs
    .map(log => writeContract.interface.parseLog(log))  // null if not ours
    .filter(event => event && CREATION_EVENTS.includes(event.name))
    .map(event => `${event.name} ID ${event.args.id}`);
}

// Link a form to a contract call.
function onSubmit(formId, send) {
  $(formId).onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    const buttons = document.querySelectorAll('button');
    buttons.forEach(button => button.disabled = true);
    try {
      if (!writeContract) throw Error('Connect MetaMask first.');
      $('status').textContent = 'Confirm in MetaMask…';
      $('transaction').replaceChildren();

      const tx = await send(values);

      const link = document.createElement('a');
      link.href = `https://sepolia.etherscan.io/tx/${tx.hash}`;
      link.textContent = 'View transaction on Sepolia Etherscan';
      link.target = '_blank';
      link.rel = 'noopener';
      $('transaction').append(link);
      $('status').textContent = 'Transaction submitted. Please wait for confirmation.';

      const receipt = await tx.wait();
      $('status').textContent = ['Confirmed.', ...newRecordIds(receipt)].join(' ');

      // New product: show its QR.
      const productId = idFromReceipt(receipt, 'ProductCreated');
      if (productId !== null) showLabel(productId);
    } catch (err) {
      $('status').textContent = errorText(err);
    } finally {
      buttons.forEach(button => button.disabled = false);
    }
  };
}

const toUnixTime = localDateTime => Math.floor(new Date(localDateTime).getTime() / 1000);
const toIdList = text => text.split(',').map(id => BigInt(id.trim()));

onSubmit('register', v => writeContract.register(v.address, Number(v.role)));
onSubmit('certifyFarm', v => writeContract.certifyFarm(v.farm, toUnixTime(v.until), v.hash));
onSubmit('createMilk', v => writeContract.createMilk(v.processor, BigInt(v.litres)));
onSubmit('createProduct', v => writeContract.createProduct(toIdList(v.ids), v.distributor));
onSubmit('receiveProduct', v => writeContract.receiveProduct(BigInt(v.id)));

// Connect MetaMask account
$('connect').onclick = async () => {
  try {
    const contract = await getReadContract();
    if (!window.ethereum) {
      throw Error('Install MetaMask in this browser for stakeholder actions.');
    }

    await window.ethereum.request({ method: 'eth_requestAccounts' });
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + config.chainId.toString(16) }],
    });

    const signer = await new BrowserProvider(window.ethereum).getSigner();
    const address = await signer.getAddress();
    writeContract = new Contract(config.contractAddress, abi, signer);

    const isAdmin = (await contract.admin()).toLowerCase() === address.toLowerCase();
    const roleName = isAdmin ? 'Administrator' : ROLE_NAMES[Number(await contract.roles(address))];

    $('account').textContent = `${address} · ${roleName}`;

    // Show this role's forms only.
    $('adminActions').hidden = !isAdmin;
    $('auditorActions').hidden = roleName !== 'Auditor';
    $('farmActions').hidden = roleName !== 'Farm';
    $('processorActions').hidden = roleName !== 'Processor';
    $('distributorActions').hidden = roleName !== 'Distributor';
  } catch (err) {
    $('status').textContent = errorText(err);
  }
};

// Reload on account or network change.
window.ethereum?.on('accountsChanged', () => location.reload());
window.ethereum?.on('chainChanged', () => location.reload());


// QR scan: ?id= in the URL.
const scanned = new URLSearchParams(location.search).get('id');
if (scanned) {
  // Shopper view: result only.
  $('workspace').hidden = true;
  $('lookup').hidden = true;
  $('consumerIntro').hidden = true;
  $('consumerTitle').textContent = 'Where your milk came from';
  $('again').hidden = false;

  // Show workspace if a wallet is already connected (no popup).
  window.ethereum?.request({ method: 'eth_accounts' })
    .then(accounts => { if (accounts.length) $('workspace').hidden = false; })
    .catch(() => {});

  $('lookup').querySelector('input[name="id"]').value = scanned;
  lookupBatch(scanned).catch(err => { $('result').textContent = errorText(err); });
}

// Show the form again.
$('again').onclick = () => {
  $('lookup').hidden = false;
  $('again').hidden = true;
  $('lookup').querySelector('input[name="id"]').focus();
};
