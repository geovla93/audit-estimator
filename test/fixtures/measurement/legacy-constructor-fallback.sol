pragma solidity 0.4.11;
contract LegacyVault {
    uint public value;
    function LegacyVault(uint initial) public { value = initial; }
    function() public payable { value += msg.value; }
}
