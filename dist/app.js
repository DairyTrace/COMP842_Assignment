import { BrowserProvider, JsonRpcProvider, Contract, isAddress } from '/ethers.js';

const config = await (await fetch('/config.json')).json();
const abi = await (await fetch('/abi.json')).json();

// Index = the role's number in `enum Role` in contracts/DairyTrace.sol.
const ROLE_NAMES = ['Unregistered', 'Auditor', 'Farm', 'Processor', 'Distributor'];

let readContract;   // reads the chain over the public RPC (no wallet needed)
let writeContract;  // sends transactions through MetaMask (set by Connect below)

const $ = id => document.getElementById(id);
const errorText = err => err.shortMessage || err.reason || err.message || String(err);
const asDate = seconds => new Date(Number(seconds) * 1000).toISOString();

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

  const lines = [
    `Product ${id}`,
    `Milk input: ${product.litres} L`,
    `Processor: ${product.processor}`,
    `Distributor: ${product.distributor}`,
    `Receipt confirmed: ${product.received ? 'Yes' : 'No'}`,
    `Recorded: ${asDate(product.createdAt)}`,
  ];

  for (const milkId of product.milkIds) {
    const milk = await contract.milk(milkId);
    lines.push(
      `\nMilk ${milkId}: ${milk.litres} L; farm ${milk.farm}`,
      `Certificate at registration: ${milk.certificateId || 'none'}`,
    );
    if (milk.certificateId !== 0n) {
      const cert = await contract.certificates(milk.certificateId);
      lines.push(
        `Auditor: ${cert.auditor}`,
        `Issued: ${asDate(cert.issuedAt)}`,
        `Expiry: ${asDate(cert.validUntil)}`,
        `Audit SHA-256: ${cert.evidenceHash}`,
      );
    }
  }

  const heading = document.createElement('h3');
  heading.className = product.certified ? 'pass' : 'fail';
  heading.textContent = product.certified
    ? 'Eligible under the demo fair-trade rule'
    : 'Not eligible under the demo fair-trade rule';

  const details = document.createElement('pre');
  details.textContent = lines.join('\n');

  $('result').replaceChildren(heading, details);
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
