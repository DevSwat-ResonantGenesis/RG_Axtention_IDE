import os
import time
import sys

INPUT_FILE = "bridge_input.txt"
OUTPUT_FILE = "bridge_output.txt"

def main():
    print("\n" + "="*60)
    print("             DEVSWAT ULTIMATE TERMINAL BRIDGE             ")
    print("="*60)
    print("Status: LISTENING... Type 'exit' to quit.\n")

    # Clear previous state
    if os.path.exists(INPUT_FILE): os.remove(INPUT_FILE)
    if os.path.exists(OUTPUT_FILE): os.remove(OUTPUT_FILE)

    while True:
        try:
            user_input = input("You > ").strip()
            if not user_input:
                continue
            if user_input.lower() == 'exit':
                print("Closing bridge...")
                break

            # Write input for AI to read
            with open(INPUT_FILE, "w") as f:
                f.write(user_input)
            
            print("AI is thinking...", end="\r")

            # Wait for AI response
            while not os.path.exists(OUTPUT_FILE):
                time.sleep(0.5)
            
            # Read and print AI response
            with open(OUTPUT_FILE, "r") as f:
                response = f.read()
            
            print(" " * 20, end="\r") # Clear thinking line
            print(f"DevSwat > {response}\n")
            
            # Cleanup for next turn
            os.remove(OUTPUT_FILE)
            if os.path.exists(INPUT_FILE): os.remove(INPUT_FILE)

        except KeyboardInterrupt:
            break
        except Exception as e:
            print(f"\nError: {e}")
            break

if __name__ == "__main__":
    main()
