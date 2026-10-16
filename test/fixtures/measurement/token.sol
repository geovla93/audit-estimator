pragma solidity 0.8.37;
contract TinyToken {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    function mint(address recipient, uint256 amount) external {
        if (amount == 0) { return; }
        totalSupply += amount;
        balanceOf[recipient] += amount;
    }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[recipient] += amount;
        return true;
    }
}
