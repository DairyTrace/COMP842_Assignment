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
  out.push(el('h3', product.certified ? 'pass' : 'fail',
    product.certified
      ? 'Eligible under the demo fair-trade rule'
      : 'Not eligible under the demo fair-trade rule'));

  out.push(el('p', 'headline',
    `Product ${id} · ${product.litres} litres · pooled ${asDate(product.createdAt)}`));

  // --- one sentence covering where it came from and whether it was audited ---
  const lotWord = `${lots.length} milk lot${lots.length === 1 ? '' : 's'}`;
  const farmWord = `${farms.length} farm${farms.length === 1 ? '' : 's'}`;
  const uncertified = lots.filter(lot => lot.certificateId === 0n).length;

  // Every audit covering this batch expires at some point; quote the earliest.
  const expiries = [...certs.values()].map(cert => Number(cert.validUntil));
  const soonest = expiries.length ? asDate(Math.min(...expiries)) : null;

  out.push(el('p', 'summary', product.certified
    ? `Made from ${lotWord} from ${farmWord}, each covered by a farm audit valid until ${soonest}.`
    : `Made from ${lotWord} from ${farmWord}. ${uncertified} had no valid farm audit when registered, ` +
      `and one uncertified lot makes the whole batch ineligible.`));

  out.push(el('p', product.received ? 'ok' : 'waiting', product.received
    ? 'Receipt confirmed by the distributor.'
    : 'The distributor has not yet confirmed receipt.'));

  // --- everything, for anyone who wants to check it ---
  // Audits are listed once each rather than repeated under every lot they cover.
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
