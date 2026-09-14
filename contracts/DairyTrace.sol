// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Educational whole-lot traceability; no real certification or payments.
///
/// The chain of custody runs in one direction:
///
///     Auditor certifies a Farm
///        -> Farm registers a Milk lot, addressed to a Processor
///           -> Processor pools 1-20 Milk lots into a Product, addressed to a Distributor
///              -> Distributor confirms receipt
///
/// A Product is "certified" only if every milk lot in it already carried a valid
/// farm certificate at the moment that lot was registered.
/// Consumers read the result with getProduct(), which needs no wallet and no role.

contract DairyTrace {
    /// Every address starts at None, because 0 is the default value of the enum.
    /// So "unregistered" is the default.
    enum Role { None, Auditor, Farm, Processor, Distributor }

    /// The admin holds no Role so whoever administers the system cannot also act as a farm or processor.
    address public immutable admin;

    /// Permission checks two questions, needs yes for both.
    ///   roles[x]  - what x is allowed to be
    ///   active[x] - whether x is currently switched on
    /// Lets the admin suspend a participant with setActive() without erasing their role.
    mapping(address => Role) public roles;
    mapping(address => bool) public active;

    // ---------------------------------------------------------------------
    // Records
    // ---------------------------------------------------------------------

    /// AUDIT- `evidenceHash` is the SHA-256 of the audit
    struct Certificate {
        address farm;
        address auditor;
        uint256 issuedAt;
        uint256 validUntil;
        bytes32 evidenceHash;
    }

    /// One lot of milk.
    /// 0 means "this farm had no valid certificate when the lot was registered".
    /// `consumed` flips to true once the lot has been pooled into a product,
    /// which is what stops the same milk being sold twice.
    struct Milk {
        address farm;
        address processor;
        uint256 litres;
        uint256 certificateId;
        uint256 createdAt;
        bool consumed;
    }

    /// One finished batch, pooled from the milk lots listed in `milkIds`.
    struct Product {
        address processor;
        address distributor;
        uint256 litres;
        uint256 createdAt;
        bool certified;
        bool received;
        uint256[] milkIds;
    }

    /// `public` generates a free getter, so the page can call certificates(id) and milk(id) directly.
    mapping(uint256 => Certificate) public certificates;
    mapping(uint256 => Milk) public milk;

    /// The farm's most recent certificate. Re-certifying overwrites this pointer;
    /// the old Certificate stays in `certificates` so past milk keeps its evidence.
    mapping(address => uint256) public currentCertificate;

    mapping(uint256 => Product) private products;

    uint256 public certificateCount;
    uint256 public milkCount;
    uint256 public productCount;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// Emitted on every state change. The page reads the `id` out of the
    /// transaction receipt to tell the user which record was just created.
    /// `indexed` parameters are the ones you can filter logs by.
    event Registered(address indexed account, Role role);
    event ActiveChanged(address indexed account, bool enabled);
    event Certified(uint256 indexed id, address indexed farm, address indexed auditor);
    event MilkCreated(uint256 indexed id, address indexed farm, address indexed processor);
    event ProductCreated(uint256 indexed id, bool certified);
    event Received(uint256 indexed id, address indexed distributor);

    constructor() {
        admin = msg.sender;
    }

    // ---------------------------------------------------------------------
    // Access control
    // ---------------------------------------------------------------------

    /// Runs before the function body; `_` is where that body is spliced in.
    /// Demands the exact role *and* an active account.
    modifier onlyRole(Role r) {
        require(active[msg.sender] && roles[msg.sender] == r, "Wrong role or disabled");
        _;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Admin only");
        _;
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// Gives an address a role, once. Re-registering is refused rather than
    /// allowed to overwrite, because a participant's role is baked into records
    /// they have already created.
    /// Use setActive() to suspend someone instead.
    function register(address account, Role role) external onlyAdmin {
        // Rejects the zero address, the admin itself (see the note on `admin`),
        // and Role.None, which would otherwise be a backdoor way to unregister.
        require(account != address(0) && account != admin && role != Role.None, "Invalid registration");
        require(roles[account] == Role.None, "Already registered");

        roles[account] = role;
        active[account] = true; // registering also switches the account on
        emit Registered(account, role);
    }

    /// Suspends or restores a participant. Their role and records are untouched,
    /// so this is reversible: setActive(x, false) then setActive(x, true) returns
    /// x to where it was.
    function setActive(address account, bool enabled) external onlyAdmin {
        require(roles[account] != Role.None, "Unknown account");

        active[account] = enabled;
        emit ActiveChanged(account, enabled);
    }

    // ---------------------------------------------------------------------
    // The supply chain
    // ---------------------------------------------------------------------

    /// Auditor records an audit of a farm, valid until `validUntil`.
    /// Does not touch existing milk (it only changes what future lots inherit).
    function certifyFarm(address farm, uint256 validUntil, bytes32 evidenceHash)
        external
        onlyRole(Role.Auditor)
    {
        // The target must actually be a live farm, so a typo cannot certify
        // a processor, an unknown address, or a suspended farm.
        require(active[farm] && roles[farm] == Role.Farm, "Unknown farm");
        // An expiry in the past would be certified and expired at once
        require(validUntil > block.timestamp && evidenceHash != bytes32(0), "Invalid certificate");

        uint256 id = ++certificateCount;
        certificates[id] = Certificate(farm, msg.sender, block.timestamp, validUntil, evidenceHash);
        currentCertificate[farm] = id;
        emit Certified(id, farm, msg.sender);
    }

    /// Farm registers a lot of raw milk and hands it to a named processor.
    function createMilk(address processor, uint256 litres) external onlyRole(Role.Farm) {
        require(active[processor] && roles[processor] == Role.Processor, "Unknown processor");
        require(litres > 0, "Zero volume");

        // The farm's certificate is resolved once, here, and stored on the lot. An expired certificate
        // counts as none. Because the lot keeps this number forever, certifying
        // the farm later cannot retroactively make an earlier milk lot eligible.
        uint256 cert = currentCertificate[msg.sender];
        if (cert != 0 && certificates[cert].validUntil <= block.timestamp) cert = 0;

        uint256 id = ++milkCount;
        milk[id] = Milk(msg.sender, processor, litres, cert, block.timestamp, false);
        emit MilkCreated(id, msg.sender, processor);
    }

    /// Processor pools milk lots into one finished product for a distributor.
    /// The product is certified only if every single input lot was certified.
    function createProduct(uint256[] calldata ids, address distributor)
        external
        onlyRole(Role.Processor)
    {
        // The upper bound keeps the loop below within a reasonable gas cost.
        require(ids.length > 0 && ids.length <= 20, "Use 1 to 20 lots");
        require(active[distributor] && roles[distributor] == Role.Distributor, "Unknown distributor");

        uint256 total;          // litres accumulated across the inputs
        bool eligible = true;   // stays true only while every lot is certified

        for (uint256 i; i < ids.length; i++) {
            // `storage`, not `memory`: `lot` is a reference to the real record,
            // so assigning to lot.consumed below writes it back to the chain.
            Milk storage lot = milk[ids[i]];

            // lot.farm == 0 means the ID has never been issued. The second half
            // stops a processor pooling milk that was addressed to someone else.
            require(lot.farm != address(0) && lot.processor == msg.sender, "Invalid milk owner");
            require(!lot.consumed, "Milk already consumed");
            lot.consumed = true;

            total += lot.litres;
            if (lot.certificateId == 0) eligible = false; // one bad lot taints the batch
        }

        uint256 id = ++productCount;
        // `p` is a reference to the stored record, so each assignment below
        // writes to the chain.
        Product storage p = products[id];
        p.processor = msg.sender;
        p.distributor = distributor;
        p.litres = total;
        p.createdAt = block.timestamp;
        p.certified = eligible;
        p.milkIds = ids;
        emit ProductCreated(id, eligible);
    }

    /// Distributor acknowledges physical receipt, closing the chain of custody.
    function receiveProduct(uint256 id) external onlyRole(Role.Distributor) {
        Product storage p = products[id];
        // Unknown products have a zero processor
        // Only the distributor this batch was addressed to can sign for it.
        require(p.processor != address(0) && p.distributor == msg.sender, "Wrong recipient");
        require(!p.received, "Already received");

        p.received = true;
        emit Received(id, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Public read
    // ---------------------------------------------------------------------
    /// Returns the whole struct including `milkIds`,
    /// which the page walks to display each lot and its certificate.
    function getProduct(uint256 id) external view returns (Product memory) {
        require(products[id].processor != address(0), "Unknown product");
        return products[id];
    }
}
