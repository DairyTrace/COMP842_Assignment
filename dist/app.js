import { BrowserProvider, JsonRpcProvider, Contract, isAddress } from './ethers.js';

const config = await (await fetch('./config.json')).json();
const abi = await (await fetch('./abi.json')).json();

// Index = the role's number in `enum Role` in contracts/DairyTrace.sol.
const ROLE_NAMES = ['Unregistered', 'Auditor', 'Farm', 'Processor', 'Distributor'];

let readContract;   // reads the chain over the public RPC (no wallet needed)
let writeContract;  // sends transactions through MetaMask (set by Connect below)

const $ = id => document.getElementById(id);
const errorText = err => err.shortMessage || err.reason || err.message || String(err);
/// Dates the way a person reads them, in their own timezone.
const asDate = seconds =>
  new Date(Number(seconds) * 1000).toLocaleDateString('en-NZ',
    { day: 'numeric', month: 'long', year: 'numeric' });

/// Addresses are 42 characters. Show enough to recognise, not enough to drown in.
const shortAddress = address => `${address.slice(0, 6)}…${address.slice(-4)}`;

/// Small DOM helper so the code below reads like the page it builds.
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

// Consumer lookup (no wallet needed)
async function lookupBatch(id) {
  const contract = await getReadContract();
  const product = await contract.getProduct(id);

  // Fetch every milk lot at once rather than one after another. A 20-lot
  // product went from 20 sequential round trips to one batch of parallel ones.
  const lots = await Promise.all(
    product.milkIds.map(async milkId => {
      const lot = await contract.milk(milkId);
      // Copy the named fields out explicitly. ethers returns a Result object,
      // which does not survive being spread into a plain object.
      return {
        id: milkId,
        farm: lot.farm,
        litres: lot.litres,
        certificateId: lot.certificateId,
        createdAt: lot.createdAt,
      };
    })
  );

  // Several lots usually share one certificate, so fetch each certificate once.
  const certIds = [...new Set(lots.map(lot => lot.certificateId).filter(cert => cert !== 0n))];
  const certList = await Promise.all(certIds.map(certId => contract.certificates(certId)));
  const certs = new Map(certIds.map((certId, i) => [certId, certList[i]]));

  const farms = [...new Set(lots.map(lot => lot.farm))];
  const out = [];

  // --- the verdict, kept in the original wording ---
  const verdict = el('h3', product.certified ? 'pass' : 'fail',
    product.certified
      ? 'Eligible under the demo fair-trade rule'
      : 'Not eligible under the demo fair-trade rule');
  out.push(verdict);

  out.push(el('p', 'headline',
    `Product ${id} · ${product.litres} litres · pooled on ${asDate(product.createdAt)}`));

  // --- what the verdict rests on, in a sentence ---
  const certifiedCount = lots.filter(lot => lot.certificateId !== 0n).length;
  out.push(el('p', 'summary', product.certified
    ? `Pooled from ${lots.length} milk lot${lots.length === 1 ? '' : 's'} across ` +
      `${farms.length} farm${farms.length === 1 ? '' : 's'}. Every lot carried a valid ` +
      `farm audit at the moment it was registered.`
    : `Pooled from ${lots.length} milk lot${lots.length === 1 ? '' : 's'}, of which ` +
      `${lots.length - certifiedCount} had no valid farm audit when registered. ` +
      `One uncertified lot makes the whole batch ineligible.`));

  // --- has anyone signed for it? ---
  out.push(el('p', product.received ? 'ok' : 'waiting', product.received
    ? `Receipt confirmed by the distributor.`
    : `The distributor has not yet confirmed receipt of this batch.`));

  // --- the lots ---
  out.push(el('h4', null, 'Milk that went into it'));
  const lotList = el('ul', 'lots');
  for (const lot of lots) {
    const item = el('li');
    item.append(el('span', 'strong', `Lot ${lot.id} · ${lot.litres} litres`));
    item.append(el('span', 'muted', ` from farm ${shortAddress(lot.farm)} · registered ${asDate(lot.createdAt)}`));
    item.append(el('div', lot.certificateId === 0n ? 'fail' : 'pass',
      lot.certificateId === 0n
        ? 'No valid audit at registration'
        : `Covered by audit ${lot.certificateId}`));
    lotList.append(item);
  }
  out.push(lotList);

  // --- the audits behind those lots, each shown once ---
  if (certs.size) {
    out.push(el('h4', null, certs.size === 1 ? 'The farm audit' : 'The farm audits'));
    for (const [certId, cert] of certs) {
      const box = el('div', 'cert');
      box.append(el('div', null,
        `Audit ${certId} · issued ${asDate(cert.issuedAt)} · valid until ${asDate(cert.validUntil)}`));
      box.append(el('div', 'muted', `Carried out by auditor ${shortAddress(cert.auditor)}`));
      box.append(el('div', 'muted', `Audit document fingerprint ${cert.evidenceHash.slice(0, 18)}…`));
      out.push(box);
    }
  }

  // --- everything, for anyone who wants to check it ---
  const full = el('details', 'full');
  full.append(el('summary', null, 'See the complete record'));
  const raw = [
    `Product ${id}`,
    `Litres: ${product.litres}`,
    `Processor: ${product.processor}`,
    `Distributor: ${product.distributor}`,
    `Receipt confirmed: ${product.received ? 'Yes' : 'No'}`,
    `Recorded: ${new Date(Number(product.createdAt) * 1000).toISOString()}`,
  ];
  for (const lot of lots) {
    raw.push('', `Milk ${lot.id}: ${lot.litres} L; farm ${lot.farm}`,
      `Certificate at registration: ${lot.certificateId || 'none'}`);
    const cert = certs.get(lot.certificateId);
    if (cert) raw.push(
      `Auditor: ${cert.auditor}`,
      `Issued: ${new Date(Number(cert.issuedAt) * 1000).toISOString()}`,
      `Expiry: ${new Date(Number(cert.validUntil) * 1000).toISOString()}`,
      `Audit SHA-256: ${cert.evidenceHash}`);
  }
  full.append(el('pre', null, raw.join('\n')));
  out.push(full);

  $('result').replaceChildren(...out);
}

$('lookup').onsubmit = async event => {
  event.preventDefault();
  try {
    await lookupBatch(new FormData(event.target).get('id'));
  } catch (err) {
    $('result').textContent = errorText(err);
  }
};


//Stakeholder workspace (needs MetaMask)
const CREATION_EVENTS = ['Certified', 'MilkCreated', 'ProductCreated'];

function newRecordIds(receipt) {
  return receipt.logs
    .map(log => writeContract.interface.parseLog(log))  // null if the log isn't ours
    .filter(event => event && CREATION_EVENTS.includes(event.name))
    .map(event => `${event.name} ID ${event.args.id}`);
}

// Single form, `send` receives the typed-in values and returns the contract call.
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

    // Only show what this account may do.
    $('adminActions').hidden = !isAdmin;
    $('auditorActions').hidden = roleName !== 'Auditor';
    $('farmActions').hidden = roleName !== 'Farm';
    $('processorActions').hidden = roleName !== 'Processor';
    $('distributorActions').hidden = roleName !== 'Distributor';
  } catch (err) {
    $('status').textContent = errorText(err);
  }
};

// Switching account or network in MetaMask invalidates writeContract, needs reload.
window.ethereum?.on('accountsChanged', () => location.reload());
window.ethereum?.on('chainChanged', () => location.reload());
