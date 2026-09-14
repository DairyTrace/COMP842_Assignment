\
## Initialise

```bash
npm install
npm run compile   # compiles the contract, writes dist/abi.json
npm start         # serves http://localhost:5173

```


## File Structure

- `contracts/DairyTrace.sol`: Remix smart contract.
- `dist/index.html`: the page. Consumer lookup, plus one form per stakeholder action.
- `dist/app.js`: connects the page to the contract.
- `dist/style.css`: styling.
- `dist/config.json`: deployment address and public Sepolia read RPC.
- `dist/abi.json`: generated contract interface.
- `scripts/serve.mjs`: small local web server.
- `scripts/compile.mjs`: optional local compiler and ABI generation.
- `package-lock.json`: dependency installation.

## Reading `dist/abi.json`

The ABI (Application Binary Interface) is the contract's interface written as JSON:
the name, argument types and return types of every function and event. It is the
translation table ethers.js needs, because the chain itself has no idea what
"createMilk" means — it only accepts raw bytes. The ABI is what lets `app.js` write

```js
writeContract.createMilk(processorAddress, 100n)
```

and have it encoded into the right transaction, and it is equally what decodes the
logs in the receipt back into readable event names in `newRecordIds()`.

**Do not edit it by hand.** It is generated: `npm run compile` overwrites the whole
file from `contracts/DairyTrace.sol`. JSON also has no comment syntax, so anything
added would both be erased on the next compile and break the page's `.json()` parse.
The commentary lives in the contract instead, which is the actual source of truth.

A single entry looks like this:

```json
{
  "type": "function",
  "name": "createMilk",
  "inputs": [
    { "name": "processor", "type": "address", "internalType": "address" },
    { "name": "litres",    "type": "uint256", "internalType": "uint256" }
  ],
  "outputs": [],
  "stateMutability": "nonpayable"
}
```

- `type` — `function`, `event`, or `constructor`. This file has 16, 6 and 1 of each.
- `inputs` / `outputs` — parameters in declaration order. `type` is the on-chain type
  used for encoding; `internalType` is what the Solidity source called it, which is
  where you see `enum DairyTrace.Role` rather than the `uint8` actually sent.
- `stateMutability` — `view` means reading only: free, no wallet, no transaction
  (`getProduct`, `milk`, `certificates`). `nonpayable` means it writes to the chain,
  so it costs gas and must be signed. `payable` would mean it also accepts ETH;
  nothing here is payable.
- On events, an `indexed` parameter is one you can filter logs by.

If the ABI and the deployed contract disagree, calls fail or return nonsense, so
recompile after any change to the contract — and redeploy, since the contract already
on Sepolia keeps running the code it was deployed with.

## Setup Steps:

1. Run `npm start` and open http://localhost:5173.
2. Create a separate wallet in MetaMask.
3. Create and name six accounts within it:

   | Account name | Purpose | Contract role number |
   |---|---|---:|
   | Admin | Deploy and register participants | No role; deployer is administrator |
   | Auditor | Record mock farm certifications | 1 |
   | Farm A | Certified milk supplier | 2 |
   | Farm B | Initially uncertified supplier | 2 |
   | Processor | Pool milk into product batches | 3 |
   | Distributor | Confirm product receipt | 4 |

4. In MetaMask's network list, enable **Show test networks**, then select **Sepolia**.
5. Get free test ETH from an Ethereum Sepolia faucet.
6. Fund each account with a small amount of Sepolia coins.
7. In Remix's File Explorer create `DairyTrace.sol`. Copy in the entire contents of `contracts/DairyTrace.sol`.
8. Open **Solidity Compiler**. Select **0.8.30** to match the exact pragma. Under advanced configuration choose EVM **paris**, enable optimisation, and use **200 runs**. Compile `DairyTrace.sol`.
9. Select **Admin** in MetaMask and **Sepolia** as the network.
10. In Remix → **Deploy & Run Transactions**, choose **Browser Extension** and MetaMask. Approve the connection and verify the displayed account is Admin and the network is Sepolia.
11. Select `DairyTrace` in the contract dropdown. Keep transaction **Value = 0**. Click **Deploy**, review MetaMask, and confirm.
12. Wait for confirmation. Save the **contract address** from Deployed Contracts (this is different from the wallet address and the deployment transaction hash).
13. Open `dist/config.json` in IDE. Put the copied address inside the empty quotes:

   ```json
   {
     "contractAddress": "PASTE_YOUR_DEPLOYED_0x_ADDRESS_HERE",
     "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
     "chainId": 11155111
   }
   ```

14. Refresh http://localhost:5173. Click **Connect MetaMask**, approve the connection, and use Admin. If switching network reloads the page, click Connect again.

The account line should say **Administrator**. Register Auditor, Farm A, Farm B, Processor, and Distributor with the roles in the table. Each registration is a separate transaction. Wait for each confirmation. To change roles during demo, select that account in MetaMask, ensure it is connected to this site, and click Connect again after the page reloads. If the browser still exposes Admin, use MetaMask's site permissions to select/connect the desired account.

The UI only shows actions for the selected role. The contract independently enforces those permissions, including when someone bypasses the UI and calls from Remix.

## To create a new mock farm audit:

1. In a second Terminal window create a mock audit file and hash its exact bytes:

   ```bash
   cd ~/Desktop/Blockchain/dairy-spike
   printf '%s\n' 'Farm A audit passed.' > demo-audit.txt
   shasum -a 256 demo-audit.txt
   ```

2. Copy the 64 hex characters, excluding the filename. Prefix them with `0x` for the certificate form.
3. Connect as Auditor. In **Certify farm**, enter the farm's address, an expiry tomorrow or later, and that digest. Submit.
# COMP842_Assignment
