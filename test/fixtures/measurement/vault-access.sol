pragma solidity 0.8.37;
library VaultMath {
    function shares(uint256 assets) internal pure returns (uint256) { return assets * 2; }
}
abstract contract Access {
    address private owner;
    modifier onlyOwner() { require(msg.sender == owner); _; }
}
contract Vault is Access {
    uint256 private totalAssets;
    function deposit(uint256 assets) external onlyOwner {
        if (assets > 0) { totalAssets += VaultMath.shares(assets); }
    }
}
