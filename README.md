\
## Initialise

```bash
npm install
npm start   # serves http://localhost:5173
```

`dist/abi.json` is already committed. Only regenerate it (from Remix, see Setup step 8 below)
after you change and redeploy the contract.


## File Structure

- `contracts/DairyTrace.sol`: Remix smart contract. Deployed on Remix, handles blockchain logic/permissioning/etc.
- `dist/index.html`: Pure fsrontend html.
- `dist/app.js`: Connects the page to the contract. Handles front end logic.
- `dist/style.css`: Frontend styling.
- `dist/config.json`: Contract deployment address and public Sepolia read RPC. Used in app.js.
- `dist/abi.json`: Contract interface (bytecode stuff), copied from Remix after each contract redeploy.
- `scripts/serve.mjs`: Local web server. This is only needed when running the app locally. If deployed on a domain, e.g. github.io then we can remove this.
- `package-lock.json`: Dependency installations.


## Setup Steps for Demoing:
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
7. In Remix's File Explorer create `DairyTrace.sol`. Copy in the entire contents of `contracts/DairyTrace.sol`. Switch MetaMask account to Admin.
8. Open **Solidity Compiler**. Select **0.8.30** to match the contract. Compile `DairyTrace.sol`. 
9. In **Deploy** on Remix, select browswer extension as the environment drop down, then select MetaMask as the subdrop down.

Under deploy, click the three dots next to DairyTract and click copy ABI. Paste it over the contents of `dist/abi.json`.
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

The account line should say **Administrator**. Register Auditor, Farm A, Farm B, Processor, and Distributor with the roles in the table. Each registration is a separate transaction. Wait for each confirmation. To change roles during demo, select that account in MetaMask and click Connect again after the page reloads.

The UI only shows actions for the selected role. The contract independently enforces those permissions, including when someone bypasses the UI and calls from Remix.

## To create a new farm audit:
1. In a second Terminal window create a mock audit file and hash its exact bytes:

   ```bash
   cd ~/Desktop/Blockchain/dairy-spike
   printf '%s\n' 'Farm A audit passed.' > demo-audit.txt
   shasum -a 256 demo-audit.txt
   ```

2. Copy the 64 hex characters, excluding the filename. Prefix them with `0x` for the certificate form.
3. Connect as Auditor. In **Certify farm**, enter the farm's address, an expiry tomorrow or later, and the 0x + sha256 from previous step, then submit.
