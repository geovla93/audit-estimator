pragma solidity 0.5.17;
contract Five {
    uint public value;
    constructor(uint initial) public { value = initial; }
    function() external payable { value += msg.value; }
}
