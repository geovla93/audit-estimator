pragma solidity 0.8.37;
interface IImplementation {
    function version() external view returns (uint256);
}
library ImplementationSlot {
    function encode(address target) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(target)));
    }
}
contract UpgradeProxy {
    address private implementation;
    function upgradeTo(address next) external { implementation = next; }
    function version() external view returns (uint256) {
        return IImplementation(implementation).version();
    }
}
