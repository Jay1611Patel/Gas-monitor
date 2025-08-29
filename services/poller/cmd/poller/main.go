package main

import (
	contextpkg "context"
	encodingjson "encoding/json"
	iopkg "io"
	logpkg "log"
	mathbig "math/big"
	nethttppkg "net/http"
	ospkg "os"
	hexpkg "encoding/hex"
	stringspkg "strings"
	timepkg "time"

	"github.com/IBM/sarama"
	"github.com/ethereum/go-ethereum/ethclient"
	typespkg "github.com/ethereum/go-ethereum/core/types"
	"github.com/joho/godotenv"
)

func getenv(key, def string) string {
	v := ospkg.Getenv(key)
	if v == "" {
		return def
	}
	return v
}

func main() {
	_ = godotenv.Load()
	broker := getenv("KAFKA_BROKER", "kafka:9092")
	topic := getenv("KAFKA_TOPIC", "onchain-gas")
	rpcURL := getenv("ETH_RPC_URL", "")
	tenant := getenv("TENANT_ID", "")

	if rpcURL == "" || tenant == "" {
		logpkg.Fatal("ETH_RPC_URL and TENANT_ID are required")
	}

	targets := make(map[string]bool)
	// bootstrap existing watches from API
	apiBase := getenv("API_BASE", "http://api:4000")
	func() {
		req, _ := nethttppkg.NewRequest("GET", apiBase+"/internal/onchain/watches?tenantId="+tenant, nil)
		resp, err := nethttppkg.DefaultClient.Do(req)
		if err != nil {
			logpkg.Printf("bootstrap watches: %v", err)
			return
		}
		defer resp.Body.Close()
		body, _ := iopkg.ReadAll(resp.Body)
		var out struct{
			Items []struct{ Contract string `json:"contract"` } `json:"items"`
		}
		_ = encodingjson.Unmarshal(body, &out)
		for _, it := range out.Items {
			targets[stringspkg.ToLower(it.Contract)] = true
		}
		logpkg.Printf("loaded %d watches", len(out.Items))
	}()

	client, err := ethclient.Dial(rpcURL)
	if err != nil {
		logpkg.Fatalf("dial rpc: %v", err)
	}
	defer client.Close()

	cfg := sarama.NewConfig()
	cfg.Producer.Return.Successes = true
	producer, err := sarama.NewSyncProducer([]string{broker}, cfg)
	if err != nil {
		logpkg.Fatalf("kafka producer: %v", err)
	}
	defer producer.Close()

	// also consume dynamic watch updates
	cfgC := sarama.NewConfig()
	cfgC.Consumer.Group.Rebalance.Strategy = sarama.BalanceStrategyRoundRobin
	consumer, err := sarama.NewConsumerGroup([]string{broker}, "onchain-watchers", cfgC)
	if err != nil {
		logpkg.Fatalf("kafka consumer: %v", err)
	}
	go func() {
		for {
			err := consumer.Consume(contextpkg.Background(), []string{"onchain-watch-requests"}, consumerGroupHandler{targets: targets, tenant: tenant})
			if err != nil {
				logpkg.Printf("consume watch: %v", err)
				timepkg.Sleep(2 * timepkg.Second)
			}
		}
	}()

	ctx := contextpkg.Background()
	chainID, err := client.NetworkID(ctx)
	if err != nil {
		logpkg.Fatalf("network id: %v", err)
	}
	// initialize last to current head on start to avoid backfill
	head, err := client.BlockByNumber(ctx, nil)
	if err != nil {
		logpkg.Fatalf("get head: %v", err)
	}
	last := head.Number().Uint64()

	for {
		head, err := client.BlockByNumber(ctx, nil)
		if err != nil {
			logpkg.Printf("block err: %v", err)
			timepkg.Sleep(3 * timepkg.Second)
			continue
		}
		if head.Number().Uint64() <= last {
			timepkg.Sleep(2 * timepkg.Second)
			continue
		}
		for bn := last + 1; bn <= head.Number().Uint64(); bn++ {
			blk, err := client.BlockByNumber(ctx, mathbig.NewInt(int64(bn)))
			if err != nil {
				logpkg.Printf("block %d err: %v", bn, err)
				continue
			}
			for _, tx := range blk.Transactions() {
				if tx.To() == nil { // contract creation
					continue
				}
				to := stringspkg.ToLower(tx.To().Hex())
				if !targets[to] {
					continue
				}
				rec, err := client.TransactionReceipt(ctx, tx.Hash())
				if err != nil {
					continue
				}
				from := ""
				if tx != nil {
					// derive sender
					signer := typespkg.LatestSignerForChainID(chainID)
					addr, err := typespkg.Sender(signer, tx)
					if err == nil {
						from = stringspkg.ToLower(addr.Hex())
					}
				}
				methodSig := ""
				if data := tx.Data(); len(data) >= 4 {
					methodSig = "0x" + hexpkg.EncodeToString(data[:4])
				}
				// fees
				effPriceWei := new(mathbig.Int)
				if rec.EffectiveGasPrice != nil {
					effPriceWei = rec.EffectiveGasPrice
				} else if tx.GasPrice() != nil {
					effPriceWei = tx.GasPrice()
				}
				baseFeeWei := blk.BaseFee()
				priorityWei := new(mathbig.Int).Sub(effPriceWei, baseFeeWei)
				if priorityWei.Sign() < 0 { priorityWei = mathbig.NewInt(0) }
				// convert to gwei floats
				gweiDiv := mathbig.NewFloat(1e9)
				effGwei := new(mathbig.Float).Quo(new(mathbig.Float).SetInt(effPriceWei), gweiDiv)
				baseGwei := new(mathbig.Float).Quo(new(mathbig.Float).SetInt(baseFeeWei), gweiDiv)
				prioGwei := new(mathbig.Float).Quo(new(mathbig.Float).SetInt(priorityWei), gweiDiv)
				effGweiF, _ := effGwei.Float64()
				baseGweiF, _ := baseGwei.Float64()
				prioGweiF, _ := prioGwei.Float64()
				// cost in ETH
				weiPerEth := mathbig.NewFloat(1e18)
				gasUsedF := new(mathbig.Float).SetInt64(int64(rec.GasUsed))
				costWeiF := new(mathbig.Float).Mul(new(mathbig.Float).SetInt(effPriceWei), gasUsedF)
				costEthF := new(mathbig.Float).Quo(costWeiF, weiPerEth)
				costEth, _ := costEthF.Float64()
				payload := map[string]any{
					"tenantId": tenant,
					"contract": to,
					"txHash": tx.Hash().Hex(),
					"blockNumber": blk.Number().Uint64(),
					"timestamp": blk.Time(),
					"from": from,
					"to": to,
					"methodSignature": methodSig,
					"gasUsed": rec.GasUsed,
					"effectiveGasPriceGwei": effGweiF,
					"baseFeeGwei": baseGweiF,
					"priorityFeeGwei": prioGweiF,
					"costEth": costEth,
				}
				value, _ := encodingjson.Marshal(payload)
				msg := &sarama.ProducerMessage{Topic: topic, Value: sarama.ByteEncoder(value)}
				_, _, _ = producer.SendMessage(msg)
			}
		}
		last = head.NumberU64()
	}
}

type consumerGroupHandler struct{ targets map[string]bool; tenant string }

func (h consumerGroupHandler) Setup(s sarama.ConsumerGroupSession) error   { return nil }
func (h consumerGroupHandler) Cleanup(s sarama.ConsumerGroupSession) error { return nil }
func (h consumerGroupHandler) ConsumeClaim(s sarama.ConsumerGroupSession, c sarama.ConsumerGroupClaim) error {
	for msg := range c.Messages() {
		var payload struct{
			TenantId string `json:"tenantId"`
			Contract string `json:"contract"`
			Action string `json:"action"`
		}
		_ = encodingjson.Unmarshal(msg.Value, &payload)
		if payload.TenantId != h.tenant { continue }
		address := stringspkg.ToLower(payload.Contract)
		if payload.Action == "add" {
			h.targets[address] = true
		} else if payload.Action == "remove" {
			delete(h.targets, address)
		}
		s.MarkMessage(msg, "")
	}
	return nil
}